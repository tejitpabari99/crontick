import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/daemon/store.js';
import { Runner } from '../../src/daemon/runner.js';
import type { Job } from '../../src/schemas/job.js';
import { FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'crontick-timeout-'));
}

describe('Integration: timeout semantics', () => {
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

  it('prompt job exceeding timeoutSec is killed and run is marked terminal', async () => {
    const job: Job = {
      id: 'timeout-job',
      enabled: true,
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: {
        kind: 'prompt',
        prompt: 'setTimeout(() => process.exit(0), 60000)',
        engine: FAKE_ENGINE_NAME,
        args: [],
        reuseSession: false,
        timeoutSec: 1,
      },
      overlap: 'skip',
      retry: { max: 0, backoffSec: 30 },
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
      action: { kind: 'prompt', prompt: 'process.exit(0)', engine: FAKE_ENGINE_NAME, args: [], reuseSession: false, timeoutSec: 10 },
      overlap: 'skip',
      retry: { max: 0, backoffSec: 30 },
    };

    const run = store.insertRun(job.id);
    await runner.run(job, run.id, store);
    expect(store.getRun(run.id)?.status).toBe('success');
  }, 15_000);
});
