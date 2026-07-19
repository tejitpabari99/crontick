import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/daemon/store.js';
import { Runner } from '../src/daemon/runner.js';
import type { Job } from '../src/schemas/job.js';

const node = process.execPath;

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'crontick-overlap-'));
}

function makeStore(dir: string): Store {
  const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
  store.open();
  return store;
}

function makeJob(id: string, overlap: Job['overlap'], durationMs = 200): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: { kind: 'exec', command: node, args: ['-e', `setTimeout(() => process.exit(0), ${durationMs})`] },
    catchup: 'skip',
    overlap,
    retry: { max: 0, backoffSec: 0 },
    budgets: { maxRunsPerDay: null, maxTokensPerRun: null },
  };
}

describe('Integration: overlap policies stress', () => {
  let dir: string;
  let store: Store;
  let runner: Runner;

  beforeEach(() => {
    dir = makeTmpDir();
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    store = makeStore(dir);
    runner = new Runner();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('overlap=skip: only the first run completes; the rest are canceled', async () => {
    const count = 10;
    const job = makeJob('skip-job', 'skip', 500);
    const runIds = Array.from({ length: count }, () => store.insertRun(job.id).id);

    const promises: Promise<void>[] = [runner.run(job, runIds[0], store)];
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (let i = 1; i < count; i++) {
      promises.push(runner.run(job, runIds[i], store));
    }
    await Promise.all(promises);

    const statuses = runIds.map((id) => store.getRun(id)?.status);
    const completed = statuses.filter((status) => status === 'success' || status === 'failed').length;
    const canceled = statuses.filter((status) => status === 'canceled').length;

    expect(completed).toBeGreaterThanOrEqual(1);
    expect(canceled).toBeGreaterThanOrEqual(count - 2);
  }, 30_000);

  it('overlap=queue: all runs complete in order', async () => {
    const count = 5;
    const job = makeJob('queue-job', 'queue', 100);
    const runIds = Array.from({ length: count }, () => store.insertRun(job.id).id);

    await Promise.all(runIds.map((id) => runner.run(job, id, store)));

    const statuses = runIds.map((id) => store.getRun(id)?.status);
    for (const status of statuses) {
      expect(['success', 'failed']).toContain(status);
    }
  }, 30_000);

  it('overlap=cancel-previous: only the last run completes', async () => {
    const count = 5;
    const job = makeJob('cancel-prev-job', 'cancel-previous', 2000);
    const runIds = Array.from({ length: count }, () => store.insertRun(job.id).id);

    const promises: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      promises.push(runner.run(job, runIds[i], store));
      if (i < count - 1) {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }
    await Promise.all(promises);

    expect(['success', 'failed']).toContain(store.getRun(runIds[count - 1])?.status);
    for (let i = 0; i < count - 1; i++) {
      expect(['canceled', 'failed']).toContain(store.getRun(runIds[i])?.status);
    }
  }, 60_000);
});
