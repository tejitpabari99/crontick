import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/daemon/store.js';
import { Runner } from '../src/daemon/runner.js';
import type { Job } from '../src/schemas/job.js';

const node = process.execPath;

describe('Integration: budget semantics', () => {
  let dir: string;
  let store: Store;
  let runner: Runner;
  const dirs: string[] = [];

  afterEach(() => {
    store?.close();
    vi.useRealTimers();
    for (const value of dirs) rmSync(value, { recursive: true, force: true });
    dirs.length = 0;
  });

  function setup(): void {
    dir = mkdtempSync(join(tmpdir(), 'crontick-budget-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
    runner = new Runner();
  }

  it('maxRunsPerDay skips further runs on same UTC day', async () => {
    setup();
    const job: Job = {
      id: 'budget-day',
      enabled: true,
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'exec', command: node, args: ['-e', 'process.exit(0)'] },
      catchup: 'skip',
      overlap: 'skip',
      retry: { max: 0, backoffSec: 30 },
      budgets: { maxRunsPerDay: 2, maxTokensPerRun: null },
    };

    for (let i = 0; i < 4; i++) {
      const run = store.insertRun(job.id);
      await runner.run(job, run.id, store);
    }

    const runs = store.listRuns({ jobId: job.id });
    const successes = runs.filter((run) => run.status === 'success').length;
    const cancels = runs.filter((run) => run.status === 'canceled').length;
    expect(successes).toBeLessThanOrEqual(2);
    expect(cancels).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('maxRunsPerDay resets next UTC day', async () => {
    setup();
    const job: Job = {
      id: 'budget-reset',
      enabled: true,
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'exec', command: node, args: ['-e', 'process.exit(0)'] },
      catchup: 'skip',
      overlap: 'skip',
      retry: { max: 0, backoffSec: 30 },
      budgets: { maxRunsPerDay: 1, maxTokensPerRun: null },
    };

    const first = store.insertRun(job.id);
    await runner.run(job, first.id, store);
    expect(store.getRun(first.id)?.status).toBe('success');

    const second = store.insertRun(job.id);
    await runner.run(job, second.id, store);
    expect(store.getRun(second.id)?.status).toBe('canceled');

    const yesterdayStart = new Date();
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    yesterdayStart.setHours(0, 0, 0, 0);
    const historic = store.insertRun(job.id, yesterdayStart.getTime() + 1000);
    store.updateRun(historic.id, { status: 'success' });

    const dir2 = mkdtempSync(join(tmpdir(), 'crontick-budget2-'));
    dirs.push(dir2);
    mkdirSync(join(dir2, 'jobs'), { recursive: true });
    const store2 = new Store(join(dir2, 'runs.db'), join(dir2, 'jobs'));
    store2.open();
    const runner2 = new Runner();

    const yestOnly = store2.insertRun(job.id, yesterdayStart.getTime() + 1000);
    store2.updateRun(yestOnly.id, { status: 'success' });

    const today = store2.insertRun(job.id);
    await runner2.run(job, today.id, store2);
    expect(store2.getRun(today.id)?.status).toBe('success');

    store2.close();
    rmSync(dir2, { recursive: true, force: true });
    dirs.splice(dirs.indexOf(dir2), 1);
  }, 30_000);

  it('maxRunsPerDay counts by UTC day, not local midnight', async () => {
    setup();
    // Freeze time at 2026-01-01T23:30:00Z (UTC day 2026-01-01).
    // A run recorded at 2026-01-01T22:00:00Z is on the same UTC day → counts.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T23:30:00Z'));

    const job: Job = {
      id: 'budget-utc',
      enabled: true,
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'exec', command: node, args: ['-e', 'process.exit(0)'] },
      catchup: 'skip',
      overlap: 'skip',
      retry: { max: 0, backoffSec: 30 },
      budgets: { maxRunsPerDay: 1, maxTokensPerRun: null },
    };

    // Insert a run backdated to 22:00 UTC (same UTC day).
    const past = store.insertRun(job.id, new Date('2026-01-01T22:00:00Z').getTime());
    store.updateRun(past.id, { status: 'success' });

    // Now try another run — budget should be exceeded.
    const current = store.insertRun(job.id);
    await runner.run(job, current.id, store);
    expect(store.getRun(current.id)?.status).toBe('canceled');

    vi.useRealTimers();
  }, 30_000);
});
