import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '../../src/client.js';
import { CrontickError } from '../../src/errors.js';
import { createApiServer } from '../../src/daemon/api.js';
import { resolveJobLogPath } from '../../src/daemon/job-log-file.js';
import type { Runner } from '../../src/daemon/runner.js';
import { Scheduler } from '../../src/daemon/scheduler.js';
import { Store } from '../../src/daemon/store.js';
import type { Job } from '../../src/schemas/job.js';

const SCRATCH = resolve('.crontick', 'runs-delete');
let home: string;
let store: Store;
let prevHome: string | undefined;
let prevUrl: string | undefined;
let server: ReturnType<typeof createApiServer> | undefined;

function job(alias: string): Job {
  return { catchUp: false,
    id: randomUUID(), alias, description: '', enabled: true,
    schedule: { kind: 'cron', cron: '0 0 * * *' },
    action: { kind: 'prompt', prompt: 'noop', args: [], reuseSession: false },
    overlap: 'skip', retry: { max: 0, backoffSec: 30 },
  };
}

/** Inserts a finished run (with output) for a job id. */
function doneRun(jobId: string, status: 'success' | 'failed' = 'success'): string {
  const run = store.insertRun(jobId);
  store.updateRun(run.id, { status, endedAt: Date.now() });
  store.setRunOutput(run.id, { format: 'text', result: 'out', engineError: null, stderr: 'e' } as never);
  return run.id;
}

function rawDb(): { prepare(sql: string): { run(...a: unknown[]): unknown } } {
  return (store as unknown as { db: ReturnType<typeof rawDb> }).db;
}

function outputCount(runId: string): number {
  return store.getRunOutput(runId) ? 1 : 0;
}

beforeEach(() => {
  home = resolve(SCRATCH, randomUUID());
  mkdirSync(join(home, 'jobs'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
  prevHome = process.env['CRONTICK_HOME'];
  prevUrl = process.env['CRONTICK_DAEMON_URL'];
  process.env['CRONTICK_HOME'] = home;
  store = new Store(join(home, 'runs.db'), join(home, 'jobs'));
  store.open();
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (prevHome === undefined) delete process.env['CRONTICK_HOME']; else process.env['CRONTICK_HOME'] = prevHome;
  if (prevUrl === undefined) delete process.env['CRONTICK_DAEMON_URL']; else process.env['CRONTICK_DAEMON_URL'] = prevUrl;
  store.close();
  rmSync(home, { recursive: true, force: true });
});

describe('Store.deleteRuns', () => {
  it('deletes by run ids, removes outputs, reports notFound', () => {
    const j = job('a'); store.upsertJob(j);
    const r1 = doneRun(j.id); const r2 = doneRun(j.id); const keep = doneRun(j.id);
    const res = store.deleteRuns({ runIds: [r1, r2, 'nope'] });
    expect(res).toEqual({ deleted: [r1, r2], skipped: [], notFound: ['nope'], jobLogRemoved: false });
    expect(store.getRun(r1)).toBeUndefined();
    expect(outputCount(r1)).toBe(0);
    expect(store.getRun(keep)).toBeDefined();
    expect(outputCount(keep)).toBe(1);
  });

  it('de-duplicates repeated run ids (no double counting)', () => {
    const j = job('dup'); store.upsertJob(j);
    const r1 = doneRun(j.id);
    const res = store.deleteRuns({ runIds: [r1, r1, 'nope', 'nope'] });
    expect(res).toEqual({ deleted: [r1], skipped: [], notFound: ['nope'], jobLogRemoved: false });
  });

  it('deletes by job alias and by job id', () => {
    const j = job('by-alias'); store.upsertJob(j);
    const r1 = doneRun(j.id);
    expect(store.deleteRuns({ jobId: 'by-alias' }).deleted).toEqual([r1]);
    const r2 = doneRun(j.id);
    expect(store.deleteRuns({ jobId: j.id }).deleted).toEqual([r2]);
  });

  it('accepts the raw id of a deleted job (orphan) and removes its log', () => {
    const j = job('gone'); store.upsertJob(j);
    const r1 = doneRun(j.id);
    rawDb().prepare('DELETE FROM jobs WHERE id = ?').run(j.id);
    const logPath = resolveJobLogPath(j.id)!;
    writeFileSync(logPath, 'x');
    const res = store.deleteRuns({ jobId: j.id });
    expect(res).toEqual({ deleted: [r1], skipped: [], notFound: [], jobLogRemoved: true });
    expect(existsSync(logPath)).toBe(false);
  });

  it('keeps the log of a live job', () => {
    const j = job('live'); store.upsertJob(j);
    doneRun(j.id);
    const logPath = resolveJobLogPath(j.id)!;
    writeFileSync(logPath, 'x');
    const res = store.deleteRuns({ jobId: 'live' });
    expect(res.jobLogRemoved).toBe(false);
    expect(existsSync(logPath)).toBe(true);
  });

  it('keeps orphan log while runs remain (skipped active run)', () => {
    const j = job('orph'); store.upsertJob(j);
    const done = doneRun(j.id);
    const active = store.insertRun(j.id); // queued
    rawDb().prepare('DELETE FROM jobs WHERE id = ?').run(j.id);
    const logPath = resolveJobLogPath(j.id)!;
    writeFileSync(logPath, 'x');
    const res = store.deleteRuns({ jobId: j.id });
    expect(res.deleted).toEqual([done]);
    expect(res.skipped).toEqual([{ id: active.id, status: 'queued' }]);
    expect(res.jobLogRemoved).toBe(false);
    expect(existsSync(logPath)).toBe(true);
  });

  it('skips queued and running runs and reports them', () => {
    const j = job('act'); store.upsertJob(j);
    const q = store.insertRun(j.id);
    const r = store.insertRun(j.id); store.updateRun(r.id, { status: 'running' });
    const res = store.deleteRuns({ runIds: [q.id, r.id] });
    expect(res.deleted).toEqual([]);
    expect(res.skipped).toEqual([{ id: q.id, status: 'queued' }, { id: r.id, status: 'running' }]);
    expect(store.getRun(q.id)).toBeDefined();
    expect(store.getRun(r.id)).toBeDefined();
  });

  it('dry run reports the same result and deletes nothing', () => {
    const j = job('dry'); store.upsertJob(j);
    const r1 = doneRun(j.id);
    rawDb().prepare('DELETE FROM jobs WHERE id = ?').run(j.id);
    const logPath = resolveJobLogPath(j.id)!;
    writeFileSync(logPath, 'x');
    const res = store.deleteRuns({ jobId: j.id, dryRun: true });
    expect(res).toEqual({ deleted: [r1], skipped: [], notFound: [], jobLogRemoved: true });
    expect(store.getRun(r1)).toBeDefined();
    expect(outputCount(r1)).toBe(1);
    expect(existsSync(logPath)).toBe(true);
  });
});

async function start(): Promise<number> {
  const ctx = {
    store, scheduler: new Scheduler(),
    runner: { run: async () => {}, cancelJob: () => false, cancelRun: () => false } as unknown as Runner,
    startedAt: new Date(), port: 0, reload: async () => {},
  };
  server = createApiServer(ctx);
  await new Promise<void>((res, rej) => { server!.listen(0, '127.0.0.1', () => res()); server!.on('error', rej); });
  ctx.port = (server.address() as AddressInfo).port; // health probe checks the reported port
  return ctx.port;
}

describe('DELETE /api/runs', () => {
  it('deletes by runId list and by jobId, honors dryRun', async () => {
    const port = await start();
    const j = job('api-j'); store.upsertJob(j);
    const r1 = doneRun(j.id); const r2 = doneRun(j.id);
    let res = await fetch(`http://127.0.0.1:${port}/api/runs?runId=${r1},${r2}&dryRun=1`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(200);
    expect((await res.json() as { deleted: string[] }).deleted).toEqual([r1, r2]);
    expect(store.getRun(r1)).toBeDefined();
    res = await fetch(`http://127.0.0.1:${port}/api/runs?runId=${r1}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    expect((await res.json() as { deleted: string[] }).deleted).toEqual([r1]);
    res = await fetch(`http://127.0.0.1:${port}/api/runs?jobId=api-j`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    expect((await res.json() as { deleted: string[] }).deleted).toEqual([r2]);
  });

  it('returns VALIDATION_ERROR for neither or both inputs', async () => {
    const port = await start();
    for (const qs of ['', '?runId=a&jobId=b', '?runId=']) {
      const res = await fetch(`http://127.0.0.1:${port}/api/runs${qs}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('CrontickClient.deleteRuns', () => {
  it('deletes via the API without prompting and validates inputs', async () => {
    const port = await start();
    process.env['CRONTICK_DAEMON_URL'] = `http://127.0.0.1:${port}`;
    const j = job('cl-j'); store.upsertJob(j);
    const r1 = doneRun(j.id); const r2 = doneRun(j.id);
    const client = createClient();
    expect((await client.deleteRuns({ runIds: [r1], dryRun: true })).deleted).toEqual([r1]);
    expect((await client.deleteRuns({ runIds: [r1] })).deleted).toEqual([r1]);
    expect((await client.deleteRuns({ job: 'cl-j' })).deleted).toEqual([r2]);
    await expect(client.deleteRuns({})).rejects.toBeInstanceOf(CrontickError);
    await expect(client.deleteRuns({ runIds: ['a'], job: 'b' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
