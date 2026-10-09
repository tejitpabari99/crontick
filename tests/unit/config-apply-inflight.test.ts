import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '../../src/daemon/runner.js';
import { Scheduler } from '../../src/daemon/scheduler.js';
import { Store } from '../../src/daemon/store.js';
import {
  applyConfigWithPolicy,
  consumeLostPendingConfigApply,
  type ConfigApplyDeps,
} from '../../src/daemon/config-apply.js';
import { PENDING_CONFIG_APPLY_FILE } from '../../src/constants/config.js';
import { CrontickError } from '../../src/errors.js';
import type { Job } from '../../src/schemas/job.js';
import { FAKE_ENGINE_CONFIG, FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';

function job(id: string, code: string, opts: Partial<Job> = {}): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: { kind: 'prompt', prompt: code, engine: FAKE_ENGINE_NAME, args: [], reuseSession: false },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
    ...opts,
  } as Job;
}

const SLEEP = 'setTimeout(() => process.exit(0), 800)';
const FOREVER = 'setTimeout(() => process.exit(0), 60000)';
const OPS = [{ op: 'set' as const, key: 'retention.maxRunsPerJob', value: 77 }];

describe('applyConfigWithPolicy', () => {
  let dir: string;
  let prevHome: string | undefined;
  let store: Store;
  let runner: Runner;
  let scheduler: Scheduler;
  let reloads: number;
  let deps: ConfigApplyDeps;
  const pending: Array<Promise<void>> = [];

  const start = (j: Job): { runId: string; done: Promise<void> } => {
    const run = store.insertRun(j.id);
    const done = runner.run(j, run.id, store);
    pending.push(done);
    return { runId: run.id, done };
  };
  const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const storedRetention = (): unknown =>
    (JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as { retention?: { maxRunsPerJob?: number } }).retention?.maxRunsPerJob;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crontick-cfgapply-'));
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    prevHome = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    writeFakeEngineConfig(dir, { engines: { [FAKE_ENGINE_NAME]: FAKE_ENGINE_CONFIG } });
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
    runner = new Runner();
    scheduler = new Scheduler();
    reloads = 0;
    deps = { runner, scheduler, dataDir: dir, reload: async () => { reloads += 1; } };
  });

  afterEach(async () => {
    await runner.cancelAllInFlight();
    await Promise.allSettled(pending.splice(0));
    scheduler.unscheduleAll();
    store.close();
    if (prevHome === undefined) delete process.env['CRONTICK_HOME'];
    else process.env['CRONTICK_HOME'] = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies immediately and reloads when nothing is in flight', async () => {
    const res = await applyConfigWithPolicy(deps, { ops: OPS });
    expect(res.inFlightPolicy).toBe('none');
    expect(res.affectedRuns).toEqual([]);
    expect(storedRetention()).toBe(77);
    expect(reloads).toBe(1);
    expect(scheduler.isPaused()).toBe(false);
  });

  it('errors listing in-flight runs when no choice is given, and changes nothing', async () => {
    const { runId } = start(job('busy', FOREVER));
    await tick();
    const err = await applyConfigWithPolicy(deps, { ops: OPS }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrontickError);
    expect((err as CrontickError).code).toBe('RUNS_IN_FLIGHT');
    expect((err as CrontickError).message).toContain(runId);
    expect((err as CrontickError).message).toContain('busy');
    expect(existsSync(join(dir, 'config.json')) && storedRetention()).not.toBe(77);
    expect(reloads).toBe(0);
    expect(store.getRun(runId)?.status).toBe('running');
    expect(scheduler.isPaused()).toBe(false);
  });

  it('rejects an unknown choice', async () => {
    const err = await applyConfigWithPolicy(deps, { ops: OPS, inFlight: 'later' as never }).catch((e: unknown) => e);
    expect((err as CrontickError).code).toBe('INVALID_IN_FLIGHT_CHOICE');
  });

  it('stop: cancels in-flight runs (canceled, no retry), drops queued runs, applies and reloads', async () => {
    const running = job('s1', FOREVER, { retry: { max: 3, backoffSec: 30 } });
    const q = job('sq', FOREVER, { overlap: 'queue' });
    const a = start(running);
    const q1 = start(q);
    await tick();
    const q2 = start(q); // queued behind q1
    await tick();
    expect(store.getRun(q2.runId)?.status).not.toBe('running');

    const res = await applyConfigWithPolicy(deps, { ops: OPS, inFlight: 'stop' });
    expect(res.inFlightPolicy).toBe('stop');
    expect(res.affectedRuns.map((r) => r.runId).sort()).toEqual([a.runId, q1.runId, q2.runId].sort());
    expect(storedRetention()).toBe(77);
    expect(reloads).toBe(1);
    for (const id of [a.runId, q1.runId, q2.runId]) {
      expect(store.getRun(id)?.status).toBe('canceled');
    }
    // No retry: only one run record per job beyond those created, and nothing in flight.
    expect(store.listRuns({ jobId: 's1' })).toHaveLength(1);
    expect(runner.listInFlight()).toEqual([]);
    expect(scheduler.isPaused()).toBe(false);
  }, 15000);

  it('stop leaves a user-requested pause in place', async () => {
    start(job('s2', FOREVER));
    await tick();
    scheduler.pause();
    await applyConfigWithPolicy(deps, { ops: OPS, inFlight: 'stop' });
    expect(scheduler.isPaused()).toBe(true);
  }, 15000);

  it('wait: pauses, waits with no timeout for runs, applies, then resumes automatically', async () => {
    const a = start(job('w1', SLEEP));
    await tick();
    let settled = false;
    const p = applyConfigWithPolicy(deps, { ops: OPS, inFlight: 'wait' }).then((r) => { settled = true; return r; });
    await tick(250);
    expect(settled).toBe(false);
    expect(scheduler.isPaused()).toBe(true);
    expect(reloads).toBe(0);
    expect(existsSync(join(dir, PENDING_CONFIG_APPLY_FILE))).toBe(true);
    expect(store.getRun(a.runId)?.status).toBe('running');

    const res = await p;
    expect(res.inFlightPolicy).toBe('wait');
    expect(store.getRun(a.runId)?.status).toBe('success');
    expect(storedRetention()).toBe(77);
    expect(reloads).toBe(1);
    expect(scheduler.isPaused()).toBe(false);
    expect(existsSync(join(dir, PENDING_CONFIG_APPLY_FILE))).toBe(false);
  }, 15000);

  it('wait: two concurrent saves are serialized and the scheduler ends resumed', async () => {
    let active = 0;
    let maxActive = 0;
    deps.reload = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick(80);
      active -= 1;
    };
    start(job('w3', SLEEP));
    await tick();
    const p1 = applyConfigWithPolicy(deps, { ops: OPS, inFlight: 'wait' });
    const p2 = applyConfigWithPolicy(deps, { ops: [{ op: 'set' as const, key: 'retention.maxLogFiles', value: 9 }], inFlight: 'wait' });
    await Promise.all([p1, p2]);
    expect(maxActive).toBe(1);
    expect(scheduler.isPaused()).toBe(false);
  }, 15000);

  it('wait: resumes and clears the marker even when the apply fails', async () => {
    start(job('w2', SLEEP));
    await tick();
    const err = await applyConfigWithPolicy(deps, { ops: [{ op: 'set', key: 'retention.maxRunsPerJob', value: -5 }], inFlight: 'wait' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(scheduler.isPaused()).toBe(false);
    expect(existsSync(join(dir, PENDING_CONFIG_APPLY_FILE))).toBe(false);
    expect(reloads).toBe(0);
  }, 15000);

  it('a reload during active runs does not disturb them', async () => {
    const j = job('r1', SLEEP);
    store.upsertJob(j);
    const a = start(j);
    await tick();
    deps.reload = async () => {
      scheduler.unscheduleAll();
      for (const x of store.listJobs()) scheduler.schedule(x);
      reloads += 1;
    };
    await applyConfigWithPolicy(deps, { ops: OPS, inFlight: 'wait' });
    expect(store.getRun(a.runId)?.status).toBe('success');
    expect(reloads).toBe(1);
  }, 15000);
});

describe('consumeLostPendingConfigApply', () => {
  it('returns and removes a leftover marker, null when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crontick-lost-'));
    try {
      expect(consumeLostPendingConfigApply(dir)).toBeNull();
      writeFileSync(join(dir, PENDING_CONFIG_APPLY_FILE), JSON.stringify({ startedAt: 5, keys: ['a.b'], runIds: ['r1'] }));
      expect(consumeLostPendingConfigApply(dir)).toEqual({ startedAt: 5, keys: ['a.b'], runIds: ['r1'] });
      expect(existsSync(join(dir, PENDING_CONFIG_APPLY_FILE))).toBe(false);
      expect(consumeLostPendingConfigApply(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
