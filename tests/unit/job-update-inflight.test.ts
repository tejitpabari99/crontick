import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '../../src/daemon/runner.js';
import { Scheduler } from '../../src/daemon/scheduler.js';
import { Store } from '../../src/daemon/store.js';
import { applyJobUpdateWithPolicy } from '../../src/daemon/config-apply.js';
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

describe('per-job in-flight scope + update policy', () => {
  let dir: string;
  let prevHome: string | undefined;
  let store: Store;
  let runner: Runner;
  let scheduler: Scheduler;
  const pending: Array<Promise<void>> = [];

  const start = (j: Job): { runId: string; done: Promise<void> } => {
    const run = store.insertRun(j.id);
    const done = runner.run(j, run.id, store);
    pending.push(done);
    return { runId: run.id, done };
  };
  const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crontick-jobupd-'));
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    prevHome = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    writeFakeEngineConfig(dir, { engines: { [FAKE_ENGINE_NAME]: FAKE_ENGINE_CONFIG } });
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
    runner = new Runner();
    scheduler = new Scheduler();
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

  it('scheduler pauses a single job: its fires become paused-tick, others still tick', () => {
    const events: string[] = [];
    scheduler.on('tick', ({ jobId }: { jobId: string }) => events.push(`tick:${jobId}`));
    scheduler.on('paused-tick', ({ jobId }: { jobId: string }) => events.push(`paused:${jobId}`));
    const fire = (id: string) => (scheduler as unknown as { fireTick(i: string, d: Date): void }).fireTick(id, new Date());
    scheduler.pauseJob('a');
    expect(scheduler.isJobPaused('a')).toBe(true);
    expect(scheduler.isJobPaused('b')).toBe(false);
    expect(scheduler.isPaused()).toBe(false);
    fire('a');
    fire('b');
    scheduler.resumeJob('a');
    fire('a');
    expect(events).toEqual(['paused:a', 'tick:b', 'tick:a']);
  });

  it('runner scopes listInFlight / waitForIdle / cancelAllInFlight to one job', async () => {
    const a = start(job('ja', FOREVER));
    const b = start(job('jb', FOREVER));
    await tick();
    expect(runner.listInFlight('ja')).toEqual([{ jobId: 'ja', runId: a.runId }]);
    expect(runner.listInFlight()).toHaveLength(2);
    await runner.cancelAllInFlight(undefined, 'ja');
    expect(store.getRun(a.runId)?.status).toBe('canceled');
    expect(store.getRun(b.runId)?.status).toBe('running');
    await runner.waitForIdle('ja'); // resolves: ja is idle even though jb runs
    expect(runner.listInFlight('jb')).toHaveLength(1);
  }, 15000);

  it('no runs in flight: applies immediately, policy none', async () => {
    let applied = 0;
    const res = await applyJobUpdateWithPolicy({ runner, scheduler }, { jobId: 'x', apply: async () => { applied += 1; return 'ok'; } });
    expect(res).toEqual({ result: 'ok', inFlightPolicy: 'none', affectedRuns: [] });
    expect(applied).toBe(1);
  });

  it('ignores runs of other jobs', async () => {
    start(job('other', FOREVER));
    await tick();
    const res = await applyJobUpdateWithPolicy({ runner, scheduler }, { jobId: 'x', apply: () => 1 });
    expect(res.inFlightPolicy).toBe('none');
  }, 15000);

  it('missing choice: RUNS_IN_FLIGHT listing only this job\'s runs, nothing applied', async () => {
    const { runId } = start(job('busy', FOREVER));
    start(job('other', FOREVER));
    await tick();
    let applied = 0;
    const err = await applyJobUpdateWithPolicy({ runner, scheduler }, { jobId: 'busy', apply: () => { applied += 1; } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrontickError);
    expect((err as CrontickError).code).toBe('RUNS_IN_FLIGHT');
    expect((err as CrontickError).message).toContain(runId);
    expect((err as CrontickError).message).not.toContain('other');
    expect(applied).toBe(0);
    expect(store.getRun(runId)?.status).toBe('running');
    expect(scheduler.isJobPaused('busy')).toBe(false);
  }, 15000);

  it('rejects an unknown choice', async () => {
    const err = await applyJobUpdateWithPolicy({ runner, scheduler }, { jobId: 'x', inFlight: 'later' as never, apply: () => 1 }).catch((e: unknown) => e);
    expect((err as CrontickError).code).toBe('INVALID_IN_FLIGHT_CHOICE');
  });

  it('stop: cancels the job\'s active + queued runs (no retry), leaves other jobs alone, then applies', async () => {
    const q = job('sq', FOREVER, { overlap: 'queue', retry: { max: 3, backoffSec: 30 } });
    const other = start(job('keep', FOREVER));
    const q1 = start(q);
    await tick();
    const q2 = start(q); // queued
    await tick();
    expect(store.getRun(q2.runId)?.status).not.toBe('running');
    let sawIdle = false;
    const res = await applyJobUpdateWithPolicy({ runner, scheduler }, {
      jobId: 'sq',
      inFlight: 'stop',
      apply: () => { sawIdle = runner.listInFlight('sq').length === 0; return 'done'; },
    });
    expect(res.inFlightPolicy).toBe('stop');
    expect(res.affectedRuns.map((r) => r.runId).sort()).toEqual([q1.runId, q2.runId].sort());
    expect(sawIdle).toBe(true);
    expect(store.getRun(q1.runId)?.status).toBe('canceled');
    expect(store.getRun(q2.runId)?.status).toBe('canceled');
    expect(store.listRuns({ jobId: 'sq' })).toHaveLength(2); // no retry runs
    expect(store.getRun(other.runId)?.status).toBe('running');
    expect(scheduler.isJobPaused('sq')).toBe(false);
  }, 15000);

  it('stop leaves a user-requested job pause in place', async () => {
    start(job('s2', FOREVER));
    await tick();
    scheduler.pauseJob('s2');
    await applyJobUpdateWithPolicy({ runner, scheduler }, { jobId: 's2', inFlight: 'stop', apply: () => 1 });
    expect(scheduler.isJobPaused('s2')).toBe(true);
  }, 15000);

  it('wait: pauses the job, applies after its runs finish, then auto-resumes', async () => {
    const a = start(job('w1', SLEEP));
    await tick();
    let settled = false;
    let statusAtApply: string | undefined;
    const p = applyJobUpdateWithPolicy({ runner, scheduler }, {
      jobId: 'w1',
      inFlight: 'wait',
      apply: () => { statusAtApply = store.getRun(a.runId)?.status; return 'ok'; },
    }).then((r) => { settled = true; return r; });
    await tick(250);
    expect(settled).toBe(false);
    expect(scheduler.isJobPaused('w1')).toBe(true);
    expect(scheduler.isPaused()).toBe(false);
    const res = await p;
    expect(res.inFlightPolicy).toBe('wait');
    expect(statusAtApply).toBe('success');
    expect(scheduler.isJobPaused('w1')).toBe(false);
  }, 15000);

  it('wait: resumes the job even when apply throws', async () => {
    start(job('w2', SLEEP));
    await tick();
    const err = await applyJobUpdateWithPolicy({ runner, scheduler }, { jobId: 'w2', inFlight: 'wait', apply: () => { throw new Error('boom'); } }).catch((e: unknown) => e);
    expect((err as Error).message).toBe('boom');
    expect(scheduler.isJobPaused('w2')).toBe(false);
  }, 15000);

  it('runs the validate hook before stopping anything', async () => {
    const { runId } = start(job('v1', FOREVER));
    await tick();
    const err = await applyJobUpdateWithPolicy({ runner, scheduler }, {
      jobId: 'v1',
      inFlight: 'stop',
      validate: () => { throw new Error('invalid'); },
      apply: () => 1,
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe('invalid');
    expect(store.getRun(runId)?.status).toBe('running');
  }, 15000);
});
