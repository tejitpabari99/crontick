/**
 * Regression test for the job-identity bug this refactor fixes: previously,
 * a job's `id` WAS its human-friendly identifier, so deleting a job and
 * recreating one with the same identifier reused run history recorded under
 * the old job (the dashboard would show the PREVIOUS run's "last status").
 *
 * Under the GUID identity model, `id` is always a fresh, immutable GUID
 * (see docs/concepts/jobs.md#identity); `alias` is the optional,
 * user-editable, human-friendly identifier. Recreating a job with the same
 * alias after deletion must get a brand-new GUID id with NO prior run
 * history, because runs reference the GUID, not the alias.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApiServer } from '../src/daemon/api.js';
import type { Runner } from '../src/daemon/runner.js';
import { Scheduler } from '../src/daemon/scheduler.js';
import { Store } from '../src/daemon/store.js';
import type { Job } from '../src/schemas/job.js';

const SCRATCH_ROOT = resolve('.crontick', 'job-alias-recreate');

function makeHome(): string {
  const dir = resolve(SCRATCH_ROOT, randomUUID());
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

function jobWithAlias(alias: string): Partial<Job> {
  return {
    alias,
    description: 'recreate-me test job',
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
  await new Promise<void>((resolveListen, reject) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
    server.on('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  ctx.port = port;
  return { server, port };
}

async function stopServer(server: ReturnType<typeof createApiServer>): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolveClose();
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

describe('recreating a job with the same alias gets a fresh GUID id and empty run history', () => {
  it('does not surface the deleted job\'s prior run history under the recreated job', async () => {
    const dir = makeHome();
    const store = makeStore(dir);
    const { server, port } = await startServer(store);

    try {
      // 1. Create the original job under alias "recreate-me".
      const created = await apiCall(port, 'POST', '/api/jobs', jobWithAlias('recreate-me'));
      expect(created.status).toBe(201);
      const original = created.data as Job;
      expect(original.alias).toBe('recreate-me');
      expect(typeof original.id).toBe('string');

      // 2. Record a completed run for the original job directly in the store
      //    (deterministic -- no need to wait on a real scheduled/triggered run).
      const run = store.insertRun(original.id);
      store.updateRun(run.id, { status: 'success', endedAt: Date.now(), exitCode: 0, durationMs: 5 });
      expect(store.listRuns({ jobId: original.id })).toHaveLength(1);

      // 3. Delete the original job.
      const deleted = await apiCall(port, 'DELETE', `/api/jobs/${original.id}`);
      expect(deleted.status).toBe(200);

      // 4. Recreate a job with the SAME alias.
      const recreated = await apiCall(port, 'POST', '/api/jobs', jobWithAlias('recreate-me'));
      expect(recreated.status).toBe(201);
      const replacement = recreated.data as Job;
      expect(replacement.alias).toBe('recreate-me');

      // The bug this test guards against: the recreated job must be a
      // brand-new GUID, distinct from the deleted job's id.
      expect(replacement.id).not.toBe(original.id);

      // 5. The recreated job's run history must be empty -- it must NOT
      //    inherit the deleted job's prior run/status.
      expect(store.listRuns({ jobId: replacement.id })).toHaveLength(0);
      const statsResponse = await apiCall(port, 'GET', `/api/stats/jobs/${replacement.id}`);
      expect(statsResponse.status).toBe(200);
      expect((statsResponse.data as { totalRuns: number; lastStatus: string | null }).totalRuns).toBe(0);
      expect((statsResponse.data as { totalRuns: number; lastStatus: string | null }).lastStatus).toBeNull();

      // The old run row is still archivally queryable by its own run id
      // (deleting a job doesn't erase run history), it's just no longer
      // associated with any live job.
      expect(store.getRun(run.id)).toMatchObject({ jobId: original.id, status: 'success' });
    } finally {
      await stopServer(server);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
