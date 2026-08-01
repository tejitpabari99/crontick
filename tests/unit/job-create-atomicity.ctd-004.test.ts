import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApiServer } from '../../src/daemon/api.js';
import type { Runner } from '../../src/daemon/runner.js';
import { Scheduler } from '../../src/daemon/scheduler.js';
import { Store } from '../../src/daemon/store.js';
import type { Job } from '../../src/schemas/job.js';

const SCRATCH_ROOT = resolve('.crontick', 'job-create-atomicity-ctd-004');

function makeHome(prefix: string): string {
  const dir = resolve(SCRATCH_ROOT, `${prefix}-${randomUUID()}`);
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

function makeStore(dir: string): Store {
  const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
  store.open();
  return store;
}

function makeRunner(): Runner {
  return {
    run: async () => {},
    cancelJob: () => false,
    cancelRun: () => false,
  } as unknown as Runner;
}

function baseJob(id: string): Job {
  return {
    id,
    description: 'original description',
    enabled: true,
    schedule: { kind: 'cron', cron: '0 0 * * *' },
    action: {
      kind: 'exec',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
  };
}

async function startServer(store: Store): Promise<{ server: ReturnType<typeof createApiServer>; port: number }> {
  const server = createApiServer({
    store,
    scheduler: new Scheduler(),
    runner: makeRunner(),
    startedAt: new Date(),
    port: 0,
    reload: async () => {},
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  return { server, port: (server.address() as AddressInfo).port };
}

async function stopServer(server: ReturnType<typeof createApiServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function apiCall(port: number, method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

describe('CTD-004 create/update schedule atomicity', () => {
  it('rejects invalid creates without persisting a job row', async () => {
    const dir = makeHome('create');
    const store = makeStore(dir);
    const { server, port } = await startServer(store);

    try {
      const result = await apiCall(port, 'POST', '/api/jobs', {
        id: 'invalid-create',
        schedule: { kind: 'cron', cron: '61 * * * *' },
        action: { kind: 'exec', command: process.execPath, args: ['-e', 'process.exit(0)'] },
      });

      expect(result.status).toBe(400);
      expect(result.data).toMatchObject({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid schedule',
        },
      });
      expect(store.getJob('invalid-create')).toBeUndefined();
      expect(store.listJobs()).toEqual([]);

      const listed = await apiCall(port, 'GET', '/api/jobs');
      expect(listed.status).toBe(200);
      expect(listed.data).toEqual([]);

      const exported = await apiCall(port, 'GET', '/api/export');
      expect(exported.status).toBe(200);
      expect(exported.data).toMatchObject({ jobs: [] });
    } finally {
      await stopServer(server);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid updates without mutating the existing job', async () => {
    const dir = makeHome('update');
    const store = makeStore(dir);
    const original = baseJob('atomic-update-job');
    store.upsertJob(original);
    const { server, port } = await startServer(store);

    try {
      const result = await apiCall(port, 'PUT', '/api/jobs/atomic-update-job', {
        description: 'should not stick',
        schedule: { kind: 'cron', cron: '61 * * * *' },
      });

      expect(result.status).toBe(400);
      expect(result.data).toMatchObject({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid schedule',
        },
      });
      expect(store.getJob('atomic-update-job')).toEqual(original);
      expect(store.listJobs()).toEqual([original]);

      const fetched = await apiCall(port, 'GET', '/api/jobs/atomic-update-job');
      expect(fetched.status).toBe(200);
      expect(fetched.data).toEqual(original);
    } finally {
      await stopServer(server);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects creates with a missing envFile before persisting the job', async () => {
    const dir = makeHome('create-missing-env');
    const store = makeStore(dir);
    const { server, port } = await startServer(store);
    const missingEnvFile = join(dir, 'missing-create.env');

    try {
      const result = await apiCall(port, 'POST', '/api/jobs', {
        id: 'missing-env-create',
        schedule: { kind: 'cron', cron: '0 0 * * *' },
        action: {
          kind: 'exec',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: dir,
          envFile: 'missing-create.env',
        },
      });

      expect(result.status).toBe(400);
      expect(result.data).toMatchObject({
        error: {
          code: 'ENV_FILE_ERROR',
          message: expect.stringContaining(missingEnvFile),
        },
      });
      expect(store.getJob('missing-env-create')).toBeUndefined();
      expect(store.listJobs()).toEqual([]);

      const listed = await apiCall(port, 'GET', '/api/jobs');
      expect(listed.status).toBe(200);
      expect(listed.data).toEqual([]);
    } finally {
      await stopServer(server);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects updates with a missing envFile and preserves the prior job definition', async () => {
    const dir = makeHome('update-missing-env');
    const store = makeStore(dir);
    const original = baseJob('missing-env-update-job');
    store.upsertJob(original);
    const { server, port } = await startServer(store);
    const missingEnvFile = join(dir, 'missing-update.env');

    try {
      const result = await apiCall(port, 'PUT', '/api/jobs/missing-env-update-job', {
        action: {
          kind: 'exec',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: dir,
          envFile: 'missing-update.env',
        },
      });

      expect(result.status).toBe(400);
      expect(result.data).toMatchObject({
        error: {
          code: 'ENV_FILE_ERROR',
          message: expect.stringContaining(missingEnvFile),
        },
      });
      expect(store.getJob('missing-env-update-job')).toEqual(original);
      expect(store.listJobs()).toEqual([original]);

      const fetched = await apiCall(port, 'GET', '/api/jobs/missing-env-update-job');
      expect(fetched.status).toBe(200);
      expect(fetched.data).toEqual(original);

      const exported = await apiCall(port, 'GET', '/api/export');
      expect(exported.status).toBe(200);
      expect(exported.data).toMatchObject({ jobs: [original] });
    } finally {
      await stopServer(server);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
