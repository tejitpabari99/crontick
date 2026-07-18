import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/daemon/store.js';
import { Runner } from '../src/daemon/runner.js';
import type { Job } from '../src/schemas/job.js';

const node = process.execPath;

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'crontick-timeout-'));
}

describe('Integration: timeout semantics', () => {
  let dir: string;
  let store: Store;
  let runner: Runner;

  beforeEach(() => {
    dir = makeTmpDir();
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
    runner = new Runner();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('script exceeding timeoutSec is killed and run is marked terminal', async () => {
    const job: Job = {
      id: 'timeout-job',
      enabled: true,
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: {
        kind: 'exec',
        command: node,
        args: ['-e', 'setTimeout(() => process.exit(0), 60000)'],
        timeoutSec: 1,
      },
      catchup: 'skip',
      overlap: 'skip',
      retry: { max: 0, backoffSec: 30 },
      budgets: { maxRunsPerDay: null, maxTokensPerRun: null },
    };

    const run = store.insertRun(job.id);
    await runner.run(job, run.id, store);
    expect(['canceled', 'timeout', 'failed']).toContain(store.getRun(run.id)?.status);
  }, 15_000);

  it('run completes before timeout if it finishes quickly', async () => {
    const job: Job = {
      id: 'fast-job',
      enabled: true,
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'exec', command: node, args: ['-e', 'process.exit(0)'], timeoutSec: 10 },
      catchup: 'skip',
      overlap: 'skip',
      retry: { max: 0, backoffSec: 30 },
      budgets: { maxRunsPerDay: null, maxTokensPerRun: null },
    };

    const run = store.insertRun(job.id);
    await runner.run(job, run.id, store);
    expect(store.getRun(run.id)?.status).toBe('success');
  }, 15_000);
});
