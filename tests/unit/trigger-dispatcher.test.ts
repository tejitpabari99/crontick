import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '../../src/daemon/runner.js';
import { Store } from '../../src/daemon/store.js';
import { TriggerDispatcher, registerAfterTrigger } from '../../src/daemon/trigger.js';
import { nullLogger } from '../../src/logger.js';
import type { Job } from '../../src/schemas/job.js';
import { FAKE_ENGINE_CONFIG, FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';

function job(code: string, extra: Partial<Job> = {}): Job {
  return {
    id: randomUUID(),
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: { kind: 'prompt', prompt: code, engine: FAKE_ENGINE_NAME, args: [], reuseSession: false },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
    ...extra,
  } as Job;
}
const after = (up: Job, status: 'success' | 'failure' | 'any' = 'success'): Job['schedule'] => ({ kind: 'after', jobId: up.id, status });
const wait = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('TriggerDispatcher + after listener', () => {
  let dir: string;
  let store: Store;
  let runner: Runner;
  let paused: Set<string>;
  let dispatcher: TriggerDispatcher;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crontick-trigger-'));
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    prev = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    writeFakeEngineConfig(dir, { engines: { [FAKE_ENGINE_NAME]: FAKE_ENGINE_CONFIG } });
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
    runner = new Runner();
    paused = new Set();
    dispatcher = new TriggerDispatcher({ store, runner, logger: nullLogger, isPaused: (id) => paused.has(id) });
  });
  afterEach(() => {
    store.close();
    if (prev === undefined) delete process.env['CRONTICK_HOME'];
    else process.env['CRONTICK_HOME'] = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  const req = { kind: 'after' as const, env: { CRONTICK_TRIGGER: 'after' }, meta: { kind: 'after', upstream: 'x' } };

  describe('dispatch', () => {
    it('skips not-found, disabled, kind-mismatch without inserting runs', () => {
      expect(dispatcher.dispatch('nope', req)).toEqual({ skipped: 'not-found' });
      const dis = job('0', { enabled: false, schedule: { kind: 'after', jobId: randomUUID(), status: 'any' } });
      store.upsertJob(dis);
      expect(dispatcher.dispatch(dis.id, req)).toEqual({ skipped: 'disabled' });
      const cron = job('0');
      store.upsertJob(cron);
      expect(dispatcher.dispatch(cron.id, req)).toEqual({ skipped: 'kind-mismatch' });
      expect(store.listRuns({ jobId: cron.id })).toHaveLength(0);
    });

    it('inserts run, persists trigger_json, runs with env, and does not recordTick', async () => {
      const up = job('0');
      const out = join(dir, 'o.txt');
      const down = job(`require("fs").writeFileSync(${JSON.stringify(out)}, process.env.CRONTICK_TRIGGER)`, { schedule: after(up) });
      store.upsertJob(up);
      store.upsertJob(down);
      const res = dispatcher.dispatch(down.id, req);
      expect(res).toHaveProperty('runId');
      const runId = (res as { runId: string }).runId;
      expect(store.getRunTrigger(runId)).toEqual({ kind: 'after', upstream: 'x' });
      await wait(500);
      expect(existsSync(out)).toBe(true);
      expect(store.getRun(runId)?.status).toBe('success');
      expect(store.getScheduleState(down.id)).toBeUndefined();
    });

    it('records a skipped run while paused; broken jobs do not dispatch', () => {
      const up = job('0');
      const down = job('0', { schedule: after(up) });
      store.upsertJob(up);
      store.upsertJob(down);
      paused.add(down.id);
      expect(dispatcher.dispatch(down.id, req)).toEqual({ skipped: 'paused' });
      const runs = store.listRuns({ jobId: down.id });
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('skipped');
      expect(store.getRunTrigger(runs[0]!.id)).toEqual({ kind: 'after', upstream: 'x' });

      paused.clear();
      const orphan = job('0', { schedule: { kind: 'after', jobId: randomUUID(), status: 'any' } });
      writeFileSync(join(dir, 'jobs', `${orphan.id}.json`), JSON.stringify(orphan));
      store.loadJobsFromDisk();
      expect(store.isJobBroken(orphan.id)).toBe(true);
      expect(dispatcher.dispatch(orphan.id, req)).toEqual({ skipped: 'broken' });
    });
  });

  describe('after listener', () => {
    // [upstream status, after-status filter, fires?]
    const table: Array<[string, 'success' | 'failure' | 'any', boolean]> = [
      ['success', 'success', true], ['success', 'failure', false], ['success', 'any', true],
      ['failed', 'success', false], ['failed', 'failure', true], ['failed', 'any', true],
      ['timeout', 'success', false], ['timeout', 'failure', true], ['timeout', 'any', true],
      ['canceled', 'success', false], ['canceled', 'failure', false], ['canceled', 'any', false],
      ['skipped', 'any', false], ['missed', 'any', false],
    ];
    it.each(table)('upstream %s x filter %s -> fires=%s', async (status, filter, fires) => {
      registerAfterTrigger({ runner, store, dispatcher, logger: nullLogger });
      const up = job('0', { alias: 'up' });
      const down = job('0', { schedule: after(up, filter) });
      store.upsertJob(up);
      store.upsertJob(down);
      const run = store.insertRun(up.id);
      runner.recordRunOutcome(up.id, run.id, { status }, store);
      await wait(150);
      expect(store.listRuns({ jobId: down.id }).length).toBe(fires ? 1 : 0);
    });

    it('sets the five env vars (alias omitted when none) and action.env cannot override', async () => {
      registerAfterTrigger({ runner, store, dispatcher, logger: nullLogger });
      const out = join(dir, 'env.json');
      const code = `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`;
      const up = job('process.exit(1)');
      const down = job(code, {
        schedule: after(up, 'any'),
        action: { kind: 'prompt', prompt: code, engine: FAKE_ENGINE_NAME, args: [], reuseSession: false, env: { CRONTICK_TRIGGER: 'spoof' } },
      } as Partial<Job>);
      store.upsertJob(up);
      store.upsertJob(down);
      const run = store.insertRun(up.id);
      await runner.run(up, run.id, store);
      await wait(600);
      const env = JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>;
      expect(env['CRONTICK_TRIGGER']).toBe('after');
      expect(env['CRONTICK_UPSTREAM_RUN_ID']).toBe(run.id);
      expect(env['CRONTICK_UPSTREAM_STATUS']).toBe('failed');
      expect(env['CRONTICK_UPSTREAM_JOB_ID']).toBe(up.id);
      expect(env['CRONTICK_UPSTREAM_JOB_ALIAS']).toBeUndefined();
      expect(store.getRunTrigger(store.listRuns({ jobId: down.id })[0]!.id)).toEqual({ kind: 'after', upstream: run.id });
    });

    it('includes alias var when upstream has one', async () => {
      registerAfterTrigger({ runner, store, dispatcher, logger: nullLogger });
      const out = join(dir, 'alias.txt');
      const up = job('0', { alias: 'build' });
      const down = job(`require("fs").writeFileSync(${JSON.stringify(out)}, process.env.CRONTICK_UPSTREAM_JOB_ALIAS)`, { schedule: after(up) });
      store.upsertJob(up);
      store.upsertJob(down);
      await runner.run(up, store.insertRun(up.id).id, store);
      await wait(600);
      expect(readFileSync(out, 'utf8')).toBe('build');
    });

    it('retries yield one dispatch; chain A->B->C fires in order; disabled downstream silent', async () => {
      registerAfterTrigger({ runner, store, dispatcher, logger: nullLogger });
      const a = job('process.exit(1)', { retry: { max: 2, backoffSec: 0 } });
      const b = job('0', { schedule: after(a, 'failure') });
      const c = job('0', { schedule: after(b, 'success') });
      const d = job('0', { enabled: false, schedule: after(a, 'any') });
      [a, b, c, d].forEach((j) => store.upsertJob(j));
      await runner.run(a, store.insertRun(a.id).id, store);
      await wait(900);
      expect(store.listRuns({ jobId: b.id })).toHaveLength(1);
      expect(store.listRuns({ jobId: c.id })).toHaveLength(1);
      expect(store.listRuns({ jobId: d.id })).toHaveLength(0);
      const bStart = store.listRuns({ jobId: b.id })[0]!.startedAt;
      const cStart = store.listRuns({ jobId: c.id })[0]!.startedAt;
      expect(cStart).toBeGreaterThanOrEqual(bStart);
    });

    it('listener registered after startup reconciliation: earlier outcomes fire nothing', async () => {
      const up = job('0');
      const down = job('0', { schedule: after(up) });
      store.upsertJob(up);
      store.upsertJob(down);
      runner.recordRunOutcome(up.id, store.insertRun(up.id).id, { status: 'success' }, store); // pre-registration
      registerAfterTrigger({ runner, store, dispatcher, logger: nullLogger });
      await wait(150);
      expect(store.listRuns({ jobId: down.id })).toHaveLength(0);
      runner.recordRunOutcome(up.id, store.insertRun(up.id).id, { status: 'success' }, store); // post-registration
      await wait(150);
      expect(store.listRuns({ jobId: down.id })).toHaveLength(1);
    });
  });
});
