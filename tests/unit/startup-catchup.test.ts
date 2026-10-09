import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/daemon/store.js';
import { Scheduler } from '../../src/daemon/scheduler.js';
import { scanMissedFires, dispatchCatchUps } from '../../src/daemon/startup-catchup.js';
import { createLogger } from '../../src/logger.js';
import { JobSchema, type Job } from '../../src/schemas/job.js';

const MIN = 60_000;
const A = '3f2b8c1e-5d4a-4b7e-9c10-2a6f8d9e0b11';
const CAP = 500;

describe('startup catch-up', () => {
  let dir: string;
  let store: Store;
  const logger = createLogger({ level: 'error', sink: () => {} });
  const scheduler = new Scheduler(logger);

  function mk(id: string, over: Record<string, unknown> = {}): Job {
    const job = JobSchema.parse({
      id,
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'prompt', prompt: 'hi', args: [], reuseSession: false, engine: 'raw' },
      ...over,
    });
    store.upsertJob(job);
    return job;
  }
  const now = 100 * MIN;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crontick-test-'));
    mkdirSync(join(dir, 'jobs'));
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const scan = () => scanMissedFires({ store, scheduler, logger, nowMs: now, cap: CAP });

  it('catchUp=false keeps N missed rows and no pending', () => {
    mk(A);
    store.recordTick(A, now - 5 * MIN - 1);
    const { summary, pending } = scan();
    expect(pending).toEqual([]);
    expect(store.listRuns({ jobId: A }).filter((r) => r.status === 'missed')).toHaveLength(5);
    expect(summary.missedRunsRecorded).toBe(5);
    expect(summary.catchUpRuns).toBe(0);
  });

  it('seeds jobs without a watermark and never catches them up', () => {
    mk(A, { catchUp: true });
    const { pending } = scan();
    expect(pending).toEqual([]);
    expect(store.getScheduleState(A)?.lastTickAt).toBe(now);
  });

  it('advances the watermark of disabled jobs without recording anything', () => {
    mk(A, { catchUp: true, enabled: false });
    store.recordTick(A, now - 50 * MIN);
    const { pending } = scan();
    expect(pending).toEqual([]);
    expect(store.listRuns({ jobId: A })).toHaveLength(0);
    expect(store.getScheduleState(A)?.lastTickAt).toBe(now);
  });

  it('N=1 yields one pending entry and no skipped rows', () => {
    mk(A, { catchUp: true });
    store.recordTick(A, now - MIN - 1);
    const { pending } = scan();
    expect(pending).toHaveLength(1);
    expect(pending[0].plannedAt.getTime()).toBe(now - MIN);
    expect(pending[0].missed).toBe(1);
    expect(store.listRuns({ jobId: A })).toHaveLength(0);
  });

  it('N=5: one run at the latest fire, four skipped with reason, watermark = now', () => {
    mk(A, { catchUp: true });
    store.recordTick(A, now - 5 * MIN - 1);
    const { summary, pending } = scan();
    expect(pending).toHaveLength(1);
    expect(pending[0].plannedAt.getTime()).toBe(now - MIN);
    const run = vi.fn().mockResolvedValue(undefined);
    dispatchCatchUps({ store, runner: { run } as never, logger }, pending, summary, now);
    const runs = store.listRuns({ jobId: A });
    const skipped = runs.filter((r) => r.status === 'skipped');
    expect(skipped).toHaveLength(4);
    const real = runs.filter((r) => r.status !== 'skipped');
    expect(real).toHaveLength(1);
    expect(real[0].startedAt).toBe(now - MIN);
    for (const s of skipped) expect(s.error).toBe(`CATCH_UP: superseded by catch-up run ${real[0].id}`);
    expect(summary.catchUpRuns).toBe(1);
    expect(store.getScheduleState(A)?.lastTickAt).toBe(now);
    const ctx = run.mock.calls[0][3] as { env: Record<string, string> };
    expect(ctx.env).toEqual({ CRONTICK_TRIGGER: 'catch-up', CRONTICK_CATCHUP_MISSED: '5' });
  });

  it('capped: runs the true latest fire; summary row is skipped with honest wording', () => {
    mk(A, { catchUp: true });
    store.recordTick(A, now - 1000 * MIN);
    const { summary, pending } = scan();
    expect(summary.jobsCapped).toBe(1);
    expect(pending[0].plannedAt.getTime()).toBe(now - MIN);
    const run = vi.fn().mockResolvedValue(undefined);
    dispatchCatchUps({ store, runner: { run } as never, logger }, pending, summary, now);
    const runs = store.listRuns({ jobId: A });
    expect(runs.filter((r) => r.status === 'missed')).toHaveLength(0);
    const skipped = runs.filter((r) => r.status === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].error).toMatch(/^CATCH_UP: superseded by catch-up run .+capped at 500/);
    expect(summary.catchUpRuns).toBe(1);
  });

  it('one-shot with passed runAt is caught up', () => {
    mk(A, { catchUp: true, schedule: { kind: 'one-shot', runAt: new Date(now - 3 * MIN).toISOString() } });
    store.recordTick(A, now - 10 * MIN);
    const { pending } = scan();
    expect(pending).toHaveLength(1);
    expect(pending[0].plannedAt.getTime()).toBe(now - 3 * MIN);
  });

  it('records superseded fires as missed when the job vanished before dispatch', () => {
    mk(A, { catchUp: true });
    store.recordTick(A, now - 3 * MIN - 1);
    const { summary, pending } = scan();
    const disabled = { ...store.getJob(A)!, enabled: false };
    store.upsertJob(disabled);
    const run = vi.fn();
    dispatchCatchUps({ store, runner: { run } as never, logger }, pending, summary, now);
    expect(run).not.toHaveBeenCalled();
    expect(store.listRuns({ jobId: A }).filter((r) => r.status === 'missed')).toHaveLength(3);
    expect(summary.catchUpRuns).toBe(0);
  });

  it('keeps the old watermark for a pending catch-up until dispatch resolves it', () => {
    mk(A, { catchUp: true });
    store.recordTick(A, now - 3 * MIN - 1);
    const { pending } = scan();
    expect(pending).toHaveLength(1);
    expect(store.getScheduleState(A)?.lastTickAt).toBe(now - 3 * MIN - 1);
  });

  it('records fires as missed and advances the watermark when dispatch throws', () => {
    mk(A, { catchUp: true });
    store.recordTick(A, now - 3 * MIN - 1);
    const { summary, pending } = scan();
    const broken = Object.create(store) as Store;
    broken.insertRun = () => { throw new Error('store boom'); };
    dispatchCatchUps({ store: broken, runner: { run: vi.fn() } as never, logger }, pending, summary, now);
    expect(store.listRuns({ jobId: A }).filter((r) => r.status === 'missed')).toHaveLength(3);
    expect(store.getScheduleState(A)?.lastTickAt).toBe(now);
    expect(summary.catchUpRuns).toBe(0);
  });
});
