/**
 * Shared job id-or-alias resolver (resolveJobRef), the reserved alias `all`,
 * and an audit-table route test hitting each job-reference input by alias and id.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { teardownDaemon } from '../helpers/cleanup.js';
import { FAKE_ENGINE_CONFIG, FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';
import { resolveJobRef, RESERVED_JOB_REFS } from '../../src/utils/job-ref.js';
import { JobSchema } from '../../src/schemas/job.js';
import { JobCreateInputSchema, JobPatchInputSchema } from '../../src/job-input.js';

describe('resolveJobRef', () => {
  const jobs = [
    { id: 'id-1', alias: 'alpha' },
    { id: 'id-2', alias: 'id-1-alias' },
  ];
  const lookup = {
    byId: (ref: string) => jobs.find((j) => j.id === ref),
    byAlias: (ref: string) => jobs.find((j) => j.alias === ref),
  };

  it('resolves by id', () => expect(resolveJobRef('id-1', lookup)).toBe(jobs[0]));
  it('resolves by alias', () => expect(resolveJobRef('alpha', lookup)).toBe(jobs[0]));
  it('returns undefined on miss', () => expect(resolveJobRef('nope', lookup)).toBeUndefined());
  it('id wins over alias on collision', () => {
    const l = {
      byId: (r: string) => (r === 'x' ? jobs[0] : undefined),
      byAlias: (r: string) => (r === 'x' ? jobs[1] : undefined),
    };
    expect(resolveJobRef('x', l)).toBe(jobs[0]);
  });
  it('reserves "all"', () => expect(RESERVED_JOB_REFS).toContain('all'));
});

describe('reserved alias "all"', () => {
  const schedule = { kind: 'cron', cron: '0 0 * * *' };
  const action = { kind: 'prompt', prompt: 'hi', args: [], reuseSession: false };
  it('rejected on create input', () => {
    expect(JobCreateInputSchema.safeParse({ alias: 'all', schedule, action }).success).toBe(false);
  });
  it('rejected on update patch', () => {
    expect(JobPatchInputSchema.safeParse({ alias: 'all' }).success).toBe(false);
  });
  it('rejected on import (JobSchema)', () => {
    expect(JobSchema.safeParse({ alias: 'all', schedule, action }).success).toBe(false);
  });
  it('other aliases still accepted', () => {
    expect(JobPatchInputSchema.safeParse({ alias: 'all-jobs' }).success).toBe(true);
  });
});

const DAEMON_SCRIPT = resolve('dist/daemon/index.js');

function waitForPortFile(dir: string, maxMs = 30_000): Promise<number> {
  const portFile = join(dir, 'daemon.port');
  return new Promise((res, rej) => {
    const start = Date.now();
    const check = () => {
      if (existsSync(portFile)) {
        const p = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
        if (!isNaN(p) && p > 0) return res(p);
      }
      if (Date.now() - start > maxMs) return rej(new Error('daemon timeout'));
      setTimeout(check, 250);
    };
    check();
  });
}

describe('job-reference routes accept alias and id (audit table)', () => {
  let dir: string;
  let proc: ChildProcess;
  let port: number;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    let data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  };
  const make = async (alias: string) => {
    const r = await call('POST', '/api/jobs', {
      alias,
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: { kind: 'prompt', prompt: 'hello', args: [], reuseSession: false },
    });
    expect(r.status).toBe(201);
    return r.data.id as string;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crontick-jobref-'));
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFakeEngineConfig(dir, { engines: { [FAKE_ENGINE_NAME]: FAKE_ENGINE_CONFIG } });
    proc = spawn(process.execPath, [DAEMON_SCRIPT], { env: { ...process.env, CRONTICK_HOME: dir }, stdio: 'pipe' });
    port = await waitForPortFile(dir);
  }, 30_000);

  afterAll(async () => {
    await teardownDaemon(proc, dir);
  });

  it('POST create rejects alias "all"', async () => {
    const r = await call('POST', '/api/jobs', {
      alias: 'all',
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: { kind: 'prompt', prompt: 'hello', args: [], reuseSession: false },
    });
    expect(r.status).toBe(400);
  });

  it('PUT update rejects alias "all"', async () => {
    await make('upd-all');
    const r = await call('PUT', '/api/jobs/upd-all', { alias: 'all' });
    expect(r.status).toBe(400);
  });

  it('import rejects alias "all"', async () => {
    const r = await call('POST', '/api/import', {
      jobs: [{ alias: 'all', schedule: { kind: 'cron', cron: '0 0 * * *' }, action: { kind: 'prompt', prompt: 'x', args: [], reuseSession: false } }],
    });
    expect(r.data.results?.[0]?.ok ?? false).toBe(false);
  });

  const refKinds = ['alias', 'id'] as const;
  const routes: Array<{ name: string; method: string; path: (ref: string) => string; body?: unknown; expectStatus?: number }> = [
    { name: 'get', method: 'GET', path: (r) => `/api/jobs/${r}` },
    { name: 'update', method: 'PUT', path: (r) => `/api/jobs/${r}`, body: { description: 'd' } },
    { name: 'disable', method: 'POST', path: (r) => `/api/jobs/${r}/disable` },
    { name: 'enable', method: 'POST', path: (r) => `/api/jobs/${r}/enable` },
    { name: 'run', method: 'POST', path: (r) => `/api/jobs/${r}/run` },
    { name: 'run-now', method: 'POST', path: (r) => `/api/jobs/${r}/run-now` },
    { name: 'stats', method: 'GET', path: (r) => `/api/stats/jobs/${r}` },
    { name: 'export', method: 'GET', path: (r) => `/api/export?jobs=${r}` },
    { name: 'delete', method: 'DELETE', path: (r) => `/api/jobs/${r}` },
  ];

  for (const kind of refKinds) {
    for (const route of routes) {
      it(`${route.name} by ${kind}`, async () => {
        const alias = `ref-${route.name}-${kind}`;
        const id = await make(alias);
        const ref = kind === 'alias' ? alias : id;
        const r = await call(route.method, route.path(ref), route.body);
        expect(r.status, JSON.stringify(r.data)).toBeLessThan(300);
      });
    }

    it(`runs list --job by ${kind}`, async () => {
      const alias = `ref-runs-${kind}`;
      const id = await make(alias);
      const started = await call('POST', `/api/jobs/${id}/run`);
      expect(started.status).toBeLessThan(300);
      const ref = kind === 'alias' ? alias : id;
      const r = await call('GET', `/api/runs?jobId=${ref}`);
      expect(r.status).toBe(200);
      const items = (Array.isArray(r.data) ? r.data : r.data.runs ?? r.data.items) as Array<{ jobId: string }>;
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((x) => x.jobId === id)).toBe(true);
    });
  }

  it('runs list unknown ref falls through as raw id (orphans)', async () => {
    const r = await call('GET', '/api/runs?jobId=ghost-ref');
    expect(r.status).toBe(200);
  });

  it('export unknown ref -> JOB_NOT_FOUND', async () => {
    const r = await call('GET', '/api/export?jobs=ghost-ref');
    expect(r.status).toBe(404);
    expect(r.data.error?.code ?? r.data.code).toBe('JOB_NOT_FOUND');
  });
});
