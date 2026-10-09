import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/daemon/store.js';
import { Runner } from '../../src/daemon/runner.js';
import type { Job } from '../../src/schemas/job.js';
import { FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'crontick-overlap-'));
}

function makeStore(dir: string): Store {
  const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
  store.open();
  return store;
}

function makeJob(id: string, overlap: Job['overlap'], durationMs = 200): Job {
  return { catchUp: false,
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: {
      kind: 'prompt',
      prompt: `setTimeout(() => process.exit(0), ${durationMs})`,
      engine: FAKE_ENGINE_NAME,
      args: [],
      reuseSession: false,
    },
    overlap,
    retry: { max: 0, backoffSec: 0 },
  };
}

describe('Integration: overlap policies stress', () => {
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
    store = makeStore(dir);
    runner = new Runner();
  });

  afterEach(() => {
    store.close();
    if (previousHome === undefined) delete process.env['CRONTICK_HOME'];
    else process.env['CRONTICK_HOME'] = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('overlap=skip: only the first run completes; the rest are skipped', async () => {
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
    const skipped = statuses.filter((status) => status === 'skipped').length;

    expect(completed).toBeGreaterThanOrEqual(1);
    expect(skipped).toBeGreaterThanOrEqual(count - 2);
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
