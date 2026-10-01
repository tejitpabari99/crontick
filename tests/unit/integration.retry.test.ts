import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/daemon/store.js';
import { Runner } from '../../src/daemon/runner.js';
import type { Job } from '../../src/schemas/job.js';
import { FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'crontick-retry-'));
}

describe('Integration: retry semantics', () => {
  let dir: string;
  let store: Store;
  let runner: Runner;
  let previousHome: string | undefined;

  beforeEach(() => {
    dir = makeTmpDir();
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    previousHome = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    writeFakeEngineConfig(dir);
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
    runner = new Runner();
  });

  afterEach(() => {
    store.close();
    if (previousHome === undefined) delete process.env['CRONTICK_HOME'];
    else process.env['CRONTICK_HOME'] = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('retries exactly retry.max times on failure with backoffSec gap', async () => {
    const backoffSec = 0.3;
    const maxRetries = 2;
    const job: Job = {
      id: 'retry-timing',
      enabled: true,
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'prompt', prompt: 'process.exit(1)', engine: FAKE_ENGINE_NAME, args: [], reuseSession: false },
      overlap: 'skip',
      retry: { max: maxRetries, backoffSec },
    };

    const run = store.insertRun(job.id);
    const startMs = Date.now();
    await runner.run(job, run.id, store);
    const elapsed = Date.now() - startMs;

    expect(store.getRun(run.id)?.status).toBe('failed');
    const minExpected = backoffSec * 1000 * maxRetries - 200;
    expect(elapsed).toBeGreaterThanOrEqual(Math.max(0, minExpected));
  }, 30_000);

  it('does not retry on success', async () => {
    const job: Job = {
      id: 'no-retry-success',
      enabled: true,
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'prompt', prompt: 'process.exit(0)', engine: FAKE_ENGINE_NAME, args: [], reuseSession: false },
      overlap: 'skip',
      retry: { max: 3, backoffSec: 10 },
    };
    const run = store.insertRun(job.id);
    const startMs = Date.now();
    await runner.run(job, run.id, store);
    const elapsed = Date.now() - startMs;
    expect(elapsed).toBeLessThan(5000);
    expect(store.getRun(run.id)?.status).toBe('success');
  }, 15_000);
});
