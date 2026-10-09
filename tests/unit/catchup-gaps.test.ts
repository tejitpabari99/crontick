/**
 * SP10 gap tests (Task 7): real Runner + fake engine child processes, so these use real
 * timers (like trigger-dispatcher.test.ts); the pure startup math is fake-clock in
 * startup-catchup.test.ts (explicit `nowMs`).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '../../src/daemon/runner.js';
import { Store } from '../../src/daemon/store.js';
import { Scheduler } from '../../src/daemon/scheduler.js';
import { TriggerDispatcher, registerAfterTrigger } from '../../src/daemon/trigger.js';
import { scanMissedFires, dispatchCatchUps } from '../../src/daemon/startup-catchup.js';
import { nullLogger } from '../../src/logger.js';
import type { Job } from '../../src/schemas/job.js';
import { FAKE_ENGINE_CONFIG, FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';
import { startApiHarness, sampleJob, type ApiHarness } from '../helpers/api-harness.js';

const MIN = 60_000;
const NOW = 100 * MIN;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function job(code: string, extra: Partial<Job> = {}): Job {
  return {
    id: randomUUID(),
    enabled: true,
    catchUp: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: { kind: 'prompt', prompt: code, engine: FAKE_ENGINE_NAME, args: [], reuseSession: false },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
    ...extra,
  } as Job;
}

async function until(fn: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !fn()) await wait(40);
}

describe('catch-up with a real runner', () => {
  let dir: string;
  let store: Store;
  let runner: Runner;
  let prev: string | undefined;
  const scheduler = new Scheduler(nullLogger);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crontick-catchup-'));
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    prev = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    writeFakeEngineConfig(dir, { engines: { [FAKE_ENGINE_NAME]: FAKE_ENGINE_CONFIG } });
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
    runner = new Runner(undefined, undefined, undefined, 50);
  });
  afterEach(() => {
    store.close();
    if (prev === undefined) delete process.env['CRONTICK_HOME'];
    else process.env['CRONTICK_HOME'] = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  const startup = (): void => {
    const { summary, pending } = scanMissedFires({ store, scheduler, logger: nullLogger, nowMs: NOW, cap: 500 });
    dispatchCatchUps({ store, runner, logger: nullLogger }, pending, summary, NOW);
  };
  const catchUpRuns = (id: string) => store.listRuns({ jobId: id }).filter((r) => r.status !== 'skipped' && r.status !== 'missed');

  it('(a) a completed catch-up run fires its after dependent exactly once', async () => {
    const dispatcher = new TriggerDispatcher({ store, runner, logger: nullLogger, isPaused: () => false });
    registerAfterTrigger({ runner, store, dispatcher, logger: nullLogger });
    const up = job('0', { alias: 'up' });
    const down = job('0', { catchUp: false, schedule: { kind: 'after', jobId: up.id, status: 'success' } });
    store.upsertJob(up);
    store.upsertJob(down);
    store.recordTick(up.id, NOW - 4 * MIN - 1);
    startup();
    await until(() => store.listRuns({ jobId: down.id }).some((r) => r.status === 'success'));
    await wait(300); // any duplicate dispatch would have landed by now
    expect(catchUpRuns(up.id)).toHaveLength(1);
    expect(store.listRuns({ jobId: down.id })).toHaveLength(1);
    expect(store.listRuns({ jobId: up.id }).filter((r) => r.status === 'skipped')).toHaveLength(3);
  });

  it('(b) adopted orphan with overlap=skip still running: catch-up yields a visible skipped run', async () => {
    const j = job('0');
    store.upsertJob(j);
    store.recordTick(j.id, NOW - 2 * MIN - 1);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)']);
    try {
      const orphan = store.insertRun(j.id);
      store.updateRun(orphan.id, { status: 'running', pid: child.pid! });
      runner.adoptRun(j.id, orphan.id, child.pid!, store);
      startup();
      await until(() => store.listRuns({ jobId: j.id }).some((r) => r.error?.startsWith('overlap=skip')));
      const runs = store.listRuns({ jobId: j.id });
      const caught = runs.find((r) => r.error?.startsWith('overlap=skip'));
      expect(caught?.status).toBe('skipped');
      expect(caught?.startedAt).toBe(NOW - MIN);
      expect(runs.find((r) => r.id === orphan.id)?.status).toBe('running');
    } finally {
      child.kill();
    }
  });

  it('overlap=queue: catch-up goes through the queue path and completes (adopted runs do not gate queue; existing runner semantics)', async () => {
    const j = job('0', { overlap: 'queue' });
    store.upsertJob(j);
    store.recordTick(j.id, NOW - 3 * MIN - 1);
    startup();
    await until(() => catchUpRuns(j.id).some((r) => r.status === 'success'));
    expect(catchUpRuns(j.id)).toHaveLength(1);
    expect(catchUpRuns(j.id)[0]?.status).toBe('success');
    expect(store.listRuns({ jobId: j.id }).filter((r) => r.status === 'skipped')).toHaveLength(2);
  });

  it('retry: a failing catch-up run retries per the job policy', async () => {
    const counter = join(dir, 'count.txt');
    const code = `const f=${JSON.stringify(counter)};const fs=require("fs");fs.appendFileSync(f,"x");process.exit(1)`;
    const j = job(code, { retry: { max: 1, backoffSec: 0.1 } });
    store.upsertJob(j);
    store.recordTick(j.id, NOW - MIN - 1);
    startup();
    await until(() => store.listRuns({ jobId: j.id }).some((r) => r.status === 'failed'));
    expect(readFileSync(counter, 'utf8')).toBe('xx');
    expect(store.listRuns({ jobId: j.id })[0]?.status).toBe('failed');
  }, 20_000);

  it('disabled job: untouched at startup and re-enabling does not back-fill the old gap', () => {
    const j = job('0', { enabled: false });
    store.upsertJob(j);
    store.recordTick(j.id, NOW - 50 * MIN);
    startup();
    expect(store.listRuns({ jobId: j.id })).toHaveLength(0);
    expect(store.getScheduleState(j.id)?.lastTickAt).toBe(NOW);
    const again = scanMissedFires({ store, scheduler, logger: nullLogger, nowMs: NOW + 30_000, cap: 500 });
    expect(again.pending).toEqual([]);
  });

  it('interval startAt: future startAt yields nothing; past startAt runs the latest grid fire', () => {
    const future = job('0', { schedule: { kind: 'interval', everySec: 60, startAt: new Date(NOW + 10 * MIN).toISOString() } });
    const past = job('0', { schedule: { kind: 'interval', everySec: 60, startAt: new Date(NOW - 10 * MIN + 5_000).toISOString() } });
    store.upsertJob(future);
    store.upsertJob(past);
    store.recordTick(future.id, NOW - 20 * MIN);
    store.recordTick(past.id, NOW - 20 * MIN);
    const { pending } = scanMissedFires({ store, scheduler, logger: nullLogger, nowMs: NOW, cap: 500 });
    expect(pending.map((p) => p.jobId)).toEqual([past.id]);
    expect(pending[0].plannedAt.getTime()).toBe(NOW - MIN + 5_000);
    expect(pending[0].missed).toBe(10);
  });

  it('reload never catches up: the reload path does not reference the startup scan or dispatch', () => {
    const src = readFileSync(join(process.cwd(), 'src/daemon/index.ts'), 'utf8');
    const start = src.indexOf('async function reload()');
    const body = src.slice(start, src.indexOf('\n    }\n', start));
    expect(start).toBeGreaterThan(0);
    expect(body).not.toMatch(/scanMissedFires|dispatchCatchUps|dispatchTimeRun/);
    expect(src).toMatch(/dispatchCatchUps\(/);
  });
});

describe('catchUp export -> import round trip', () => {
  let h: ApiHarness;
  beforeAll(async () => { h = await startApiHarness('catchup-roundtrip'); });
  afterAll(async () => { await h.close(); });

  it('preserves catchUp true and false', async () => {
    const a = (await h.call('POST', '/api/jobs', sampleJob({ alias: 'rt-on', catchUp: true }))).data;
    const b = (await h.call('POST', '/api/jobs', sampleJob({ alias: 'rt-off', catchUp: false }))).data;
    const exported = (await h.call('GET', '/api/export')).data;
    const rows = exported.jobs as Array<Record<string, unknown>>;
    expect(rows.find((r) => r['alias'] === 'rt-on')?.['catchUp']).toBe(true);
    await h.call('DELETE', `/api/jobs/${a.id}`);
    await h.call('DELETE', `/api/jobs/${b.id}`);
    const res = await h.call('POST', '/api/import', { jobs: rows.map((r) => ({ ...r, id: randomUUID() })) });
    expect((res.data.results as Array<{ ok: boolean }>).every((r) => r.ok)).toBe(true);
    const list = (await h.call('GET', '/api/jobs')).data as Array<{ alias: string; catchUp: boolean }>;
    expect(list.find((j) => j.alias === 'rt-on')?.catchUp).toBe(true);
    expect(list.find((j) => j.alias === 'rt-off')?.catchUp).toBe(false);
  });
});
