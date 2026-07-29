import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { Runner } from '../src/daemon/runner.js';
import { Store } from '../src/daemon/store.js';
import { createApiServer } from '../src/daemon/api.js';
import type { Logger } from '../src/logger.js';
import type { Job } from '../src/schemas/job.js';
import type { Scheduler } from '../src/daemon/scheduler.js';

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crontick-runner-ctd-001-'));
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

function makeStore(dir: string): Store {
  const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
  store.open();
  return store;
}

function execJob(id: string, opts: Partial<Extract<Job['action'], { kind: 'exec' }>> = {}): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: {
      kind: 'exec',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      ...opts,
    },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 0 },
  };
}

function promptJob(id: string, opts: Partial<Extract<Job['action'], { kind: 'prompt' }>> = {}): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: {
      kind: 'prompt',
      prompt: 'hello',
      engine: 'copilot',
      args: [],
      reuseSession: false,
      ...opts,
    },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 0 },
  };
}

async function withHome<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previousHome = process.env['CRONTICK_HOME'];
  process.env['CRONTICK_HOME'] = dir;
  try {
    return await fn();
  } finally {
    if (previousHome === undefined) delete process.env['CRONTICK_HOME'];
    else process.env['CRONTICK_HOME'] = previousHome;
  }
}

function trackTerminalFinalizations(store: Store): { count: () => number; restore: () => void } {
  let terminalUpdates = 0;
  const original = store.updateRun.bind(store);
  const terminal = new Set(['success', 'failed', 'canceled', 'timeout', 'missed']);
  store.updateRun = ((runId: string, patch: Parameters<Store['updateRun']>[1]) => {
    if (patch.status && terminal.has(patch.status)) {
      terminalUpdates++;
    }
    return original(runId, patch);
  }) as Store['updateRun'];
  return {
    count: () => terminalUpdates,
    restore: () => {
      store.updateRun = original;
    },
  };
}

function createRecordingLogger(): { logger: Logger; errors: Array<{ message: string; data: unknown }> } {
  const errors: Array<{ message: string; data: unknown }> = [];
  const logger: Logger = {
    level: 'debug',
    verbose: true,
    isEnabled: () => true,
    isDebugEnabled: () => true,
    child: () => logger,
    log: (level, message, data) => {
      if (level === 'error') errors.push({ message, data });
    },
    error: (message, data) => {
      errors.push({ message, data });
    },
    warn: () => {},
    info: () => {},
    debug: () => {},
  };
  return { logger, errors };
}

describe('CTD-001 runner setup failures', () => {
  it('finalizes envFile setup failures exactly once as failed', async () => {
    const dir = makeTmpDir();
    const store = makeStore(dir);
    const tracker = trackTerminalFinalizations(store);
    try {
      const runner = new Runner();
      const job = execJob('missing-env-file', { envFile: 'missing.env' });
      const run = store.insertRun(job.id);

      await withHome(dir, async () => {
        await expect(runner.run(job, run.id, store)).resolves.toBeUndefined();
      });

      expect(store.getRun(run.id)).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('Failed to load envFile'),
      });
      expect(tracker.count()).toBe(1);
    } finally {
      tracker.restore();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finalizes prompt-engine resolution failures exactly once as failed', async () => {
    const dir = makeTmpDir();
    const store = makeStore(dir);
    const tracker = trackTerminalFinalizations(store);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      defaultEngine: 'copilot',
      engines: {
        copilot: { command: 'copilot', args: [] },
      },
    }), 'utf-8');
    try {
      const runner = new Runner();
      const job = promptJob('missing-engine', { engine: 'ghost' });
      const run = store.insertRun(job.id);

      await withHome(dir, async () => {
        await expect(runner.run(job, run.id, store)).resolves.toBeUndefined();
      });

      expect(store.getRun(run.id)).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('Prompt job requested engine "ghost"'),
      });
      expect(tracker.count()).toBe(1);
    } finally {
      tracker.restore();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finalizes synchronous spawn throws exactly once as failed', async () => {
    const dir = makeTmpDir();
    const store = makeStore(dir);
    const tracker = trackTerminalFinalizations(store);
    try {
      const runner = new Runner((() => {
        throw new Error('sync pre-spawn failure');
      }) as never);
      const job = execJob('sync-spawn-throw');
      const run = store.insertRun(job.id);

      await withHome(dir, async () => {
        await expect(runner.run(job, run.id, store)).resolves.toBeUndefined();
      });

      expect(store.getRun(run.id)).toMatchObject({
        status: 'failed',
        error: 'sync pre-spawn failure',
      });
      expect(tracker.count()).toBe(1);
    } finally {
      tracker.restore();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('logs invariant-breaking run-now rejections instead of silently swallowing them', async () => {
    const dir = makeTmpDir();
    const store = makeStore(dir);
    const { logger, errors } = createRecordingLogger();
    const job = execJob('api-run-now-rejection');
    store.upsertJob(job);

    const runner = {
      run: async () => {
        throw new Error('unexpected runner rejection');
      },
      cancelJob: () => false,
      cancelRun: () => false,
    } as unknown as Runner;

    const scheduler = {
      schedule: () => {},
      unschedule: () => {},
      validateSchedule: () => ({ ok: true }),
      previewNext: () => [],
    } as unknown as Scheduler;

    const server = createApiServer({
      store,
      scheduler,
      runner,
      startedAt: new Date(),
      port: 0,
      reload: async () => {},
      logger,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve());
        server.on('error', reject);
      });
      const port = (server.address() as AddressInfo).port;

      const response = await fetch(`http://127.0.0.1:${port}/api/jobs/${job.id}/run`, { method: 'POST' });
      expect(response.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Runner.run rejected after POST /api/jobs/:id/run returned 202',
            data: expect.objectContaining({
              jobId: job.id,
              error: expect.stringContaining('unexpected runner rejection'),
            }),
          }),
        ]),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
