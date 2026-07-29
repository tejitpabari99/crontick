import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClient } from '../src/client.js';
import { createApiServer } from '../src/daemon/api.js';
import type { Runner } from '../src/daemon/runner.js';
import { Scheduler } from '../src/daemon/scheduler.js';
import { Store } from '../src/daemon/store.js';
import type { Job } from '../src/schemas/job.js';
import { SURFACE_CAPABILITIES } from '../src/surface.js';

const SCRATCH_ROOT = resolve('.crontick', 'job-create-duplicate-ctd-005');

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

function originalJob(id: string): Job {
  return {
    id,
    description: 'original definition',
    enabled: true,
    schedule: { kind: 'interval', everySec: 60 },
    action: {
      kind: 'exec',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
  };
}

function replacementJob(id: string): Job {
  return {
    id,
    description: 'replacement definition',
    enabled: true,
    schedule: { kind: 'cron', cron: '15 6 * * *' },
    action: {
      kind: 'exec',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
    },
    overlap: 'cancel-previous',
    retry: { max: 2, backoffSec: 30 },
  };
}

async function startServer(store: Store): Promise<{ server: ReturnType<typeof createApiServer>; port: number }> {
  const ctx = {
    store,
    scheduler: new Scheduler(),
    runner: makeRunner(),
    startedAt: new Date(),
    port: 0,
    reload: async () => {},
  };
  const server = createApiServer(ctx);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  ctx.port = port;
  return { server, port };
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

describe('CTD-005 duplicate create requires explicit force', () => {
  it('API rejects duplicate create without force and preserves the original job', async () => {
    const dir = makeHome('api-reject');
    const store = makeStore(dir);
    const { server, port } = await startServer(store);

    try {
      const created = await apiCall(port, 'POST', '/api/jobs', originalJob('duplicate-api-job'));
      expect(created.status).toBe(201);

      const duplicate = await apiCall(port, 'POST', '/api/jobs', replacementJob('duplicate-api-job'));
      expect(duplicate.status).toBe(409);
      expect(duplicate.data).toMatchObject({
        error: {
          code: 'JOB_ALREADY_EXISTS',
          message: expect.stringContaining('--force'),
        },
      });

      expect(store.getJob('duplicate-api-job')).toEqual(created.data);
      const fetched = await apiCall(port, 'GET', '/api/jobs/duplicate-api-job');
      expect(fetched.status).toBe(200);
      expect(fetched.data).toEqual(created.data);
    } finally {
      await stopServer(server);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('API accepts duplicate create with force and persists the replacement', async () => {
    const dir = makeHome('api-force');
    const store = makeStore(dir);
    const { server, port } = await startServer(store);

    try {
      const created = await apiCall(port, 'POST', '/api/jobs', originalJob('duplicate-api-force-job'));
      expect(created.status).toBe(201);

      const forced = await apiCall(port, 'POST', '/api/jobs?force=1', replacementJob('duplicate-api-force-job'));
      expect(forced.status).toBe(201);
      expect(forced.data).toMatchObject({
        description: 'replacement definition',
        schedule: { kind: 'cron', cron: '15 6 * * *' },
        overlap: 'cancel-previous',
      });
      expect(store.getJob('duplicate-api-force-job')).toEqual(forced.data);
    } finally {
      await stopServer(server);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('client createJob surfaces JOB_ALREADY_EXISTS unless force is true', async () => {
    const dir = makeHome('client');
    const store = makeStore(dir);
    const { server, port } = await startServer(store);
    const client = createClient({ daemonUrl: `http://127.0.0.1:${port}`, startDaemon: false });

    try {
      await expect(client.createJob(originalJob('duplicate-client-job'))).resolves.toMatchObject({
        id: 'duplicate-client-job',
        description: 'original definition',
      });

      await expect(client.createJob(replacementJob('duplicate-client-job'))).rejects.toMatchObject({
        code: 'JOB_ALREADY_EXISTS',
        message: expect.stringContaining('force: true'),
      });

      await expect(client.getJob('duplicate-client-job')).resolves.toMatchObject({
        description: 'original definition',
        schedule: { kind: 'interval', everySec: 60 },
      });

      await expect(client.createJob(replacementJob('duplicate-client-job'), { force: true })).resolves.toMatchObject({
        description: 'replacement definition',
        schedule: { kind: 'cron', cron: '15 6 * * *' },
        overlap: 'cancel-previous',
      });
    } finally {
      await stopServer(server);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps force as an option on the existing create-job surface capability', () => {
    expect(SURFACE_CAPABILITIES.find((capability) => capability.capability === 'create-job')).toMatchObject({
      clientMethod: 'createJob',
      cliCommand: ['new'],
      mcpTool: 'crontick_job_create',
      optionNames: ['force'],
    });
    expect(SURFACE_CAPABILITIES.map((capability) => String(capability.capability))).not.toContain('overwrite-job');
  });
});
