import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/daemon/store.js';
import { Scheduler } from '../src/daemon/scheduler.js';
import type { Job } from '../src/schemas/job.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'crontick-perf-'));
}

function makeJob(id: string): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: { kind: 'exec', command: 'echo', args: [id] },
    catchup: 'skip',
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
    budgets: { maxRunsPerDay: null, maxTokensPerRun: null },
  };
}

describe('Perf (advisory — not gated)', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = makeTmpDir();
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('create 500 jobs, list them, delete them — total under 5s', () => {
    const count = 500;
    const start = Date.now();

    for (let i = 0; i < count; i++) {
      store.upsertJob(makeJob(`perf-job-${i.toString().padStart(4, '0')}`));
    }

    const jobs = store.listJobs();
    expect(jobs.length).toBe(count);

    for (const job of jobs) {
      store.deleteJob(job.id);
    }

    const elapsed = Date.now() - start;
    if (elapsed > 5000) {
      console.warn(`[PERF] 500-job CRUD took ${elapsed}ms (advisory limit: 5000ms)`);
    }
    expect(elapsed).toBeLessThan(30_000);
  });

  it('preview 100 next-fires for each of 50 cron expressions — under 2s (advisory)', () => {
    const expressions = [
      '* * * * *',
      '0 * * * *',
      '0 0 * * *',
      '0 0 * * 1',
      '*/5 * * * *',
      '0 9 * * 1-5',
      '30 8 1 * *',
      '0 0 1 1 *',
      '*/15 * * * *',
      '0 12 * * *',
    ];
    const scheduler = new Scheduler();
    const start = Date.now();

    for (let i = 0; i < 50; i++) {
      const expr = expressions[i % expressions.length];
      const results = scheduler.previewNext({ kind: 'cron', cron: expr }, { n: 100 });
      expect(results.length).toBeGreaterThan(0);
    }

    const elapsed = Date.now() - start;
    if (elapsed > 2000) {
      console.warn(`[PERF] 50x100 preview took ${elapsed}ms (advisory limit: 2000ms)`);
    }
    expect(elapsed).toBeLessThan(10_000);
  });
});
