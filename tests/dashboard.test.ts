/**
 * Core dashboard model + daemon dashboard serving tests.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { buildDashboardData, resolveDashboardAsset } from '../src/dashboard.js';
import { Scheduler } from '../src/daemon/scheduler.js';
import { Store } from '../src/daemon/store.js';
import { CrontickError } from '../src/errors.js';
import type { Job } from '../src/schemas/job.js';

const DAEMON_SCRIPT = resolve('dist/daemon/index.js');
const TIMEOUT_MS = 30_000;
const SCRATCH_ROOT = resolve('.crontick', 'dashboard-tests');

function makeScratchDir(prefix: string): string {
  const d = join(SCRATCH_ROOT, `${prefix}-${randomUUID()}`);
  mkdirSync(join(d, 'jobs'), { recursive: true });
  mkdirSync(join(d, 'logs'), { recursive: true });
  return d;
}

function waitForPortFile(dir: string, maxMs = 30_000, getStderr?: () => string): Promise<number> {
  const portFile = join(dir, 'daemon.port');
  return new Promise((resolvePort, reject) => {
    let attempts = 0;
    const maxAttempts = Math.ceil(maxMs / 250);
    const check = () => {
      if (existsSync(portFile)) {
        try {
          const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
          if (!isNaN(port) && port > 0) return resolvePort(port);
        } catch {
          // retry
        }
      }
      if (++attempts >= maxAttempts) {
        const stderr = getStderr?.() ?? '';
        return reject(new Error(`Timed out waiting for daemon${stderr ? `\nDaemon stderr:\n${stderr}` : ''}`));
      }
      setTimeout(check, 250);
    };
    check();
  });
}

async function apiCall(port: number, method: string, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, headers: res.headers, data };
}

async function rmWithRetry(path: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
  }
  rmSync(path, { recursive: true, force: true });
}

describe('core dashboard data model', () => {
  let dir: string | undefined;
  let store: Store | undefined;
  let scheduler: Scheduler | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    scheduler?.unscheduleAll();
    scheduler = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('builds the dashboard model from store and scheduler state', () => {
    dir = makeScratchDir('core');
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    scheduler = new Scheduler();
    store.open();
    const job = {
      id: 'dashboard-core-job',
      enabled: true,
      schedule: { kind: 'interval', everySec: 60 },
      action: { kind: 'exec', command: process.execPath, args: ['-v'] },
      overlap: 'skip',
      retry: { max: 0, backoffSec: 30 },
    } satisfies Job;
    store.upsertJob(job);
    scheduler.schedule(job);
    const run = store.insertRun(job.id, Date.now() - 1000);
    store.updateRun(run.id, { status: 'success', endedAt: Date.now(), durationMs: 25, exitCode: 0 });

    const data = buildDashboardData({ store, scheduler, startedAt: new Date(Date.now() - 5000), port: 12345, pid: 6789 }, { runsLimit: 10 });

    expect(data.health).toMatchObject({ ok: true, product: 'crontick', port: 12345, pid: 6789 });
    expect(data.stats).toMatchObject({ totalJobs: 1, enabledJobs: 1, totalRuns: 1, succeeded: 1, failed: 0 });
    expect(data.jobs[0]).toMatchObject({ id: job.id, scheduleLabel: 'every 60s', actionKind: 'exec', lastStatus: 'success' });
    expect(data.jobs[0].nextRunAt).toEqual(expect.any(String));
    expect(data.runs[0]).toMatchObject({ id: run.id, jobId: job.id, status: 'success', durationMs: 25, exitCode: 0 });
  });

  it('rejects dashboard asset traversal in the core resolver', () => {
    expect(() => resolveDashboardAsset('/dashboard/../../package.json')).toThrow(CrontickError);
  });
});

describe('Dashboard serving', () => {
  let dir: string;
  let daemonProc: ChildProcess;
  let port: number;

  beforeAll(async () => {
    dir = makeScratchDir('daemon');
    const stderrChunks: string[] = [];
    daemonProc = spawn(process.execPath, [DAEMON_SCRIPT], {
      env: { ...process.env, CRONTICK_HOME: dir },
      stdio: 'pipe',
    });
    daemonProc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));
    port = await waitForPortFile(dir, 30_000, () => stderrChunks.join(''));
  }, TIMEOUT_MS);

  afterAll(async () => {
    daemonProc?.kill('SIGTERM');
    await rmWithRetry(dir);
  });

  it('GET / returns 200 with text/html and <title>crontick</title>', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<title>crontick</title>');
  });

  it('GET /dashboard returns 200 with text/html', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('GET /api/dashboard/status returns the core dashboard status shape', async () => {
    const { status, data } = await apiCall(port, 'GET', '/api/dashboard/status');
    expect(status).toBe(200);
    expect(data).toMatchObject({ ok: true, running: true, url: `http://127.0.0.1:${port}/dashboard`, port });
  });

  it('GET /api/dashboard returns the core dashboard data model', async () => {
    const { status, data } = await apiCall(port, 'GET', '/api/dashboard?runsLimit=5');
    expect(status).toBe(200);
    expect(data).toMatchObject({ health: { ok: true }, stats: { totalJobs: expect.any(Number) }, jobs: expect.any(Array), runs: expect.any(Array) });
  });

  it('GET /dashboard/dashboard.js returns 200 with application/javascript', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard/dashboard.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  it('GET /dashboard/dashboard.css returns 200 with text/css', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard/dashboard.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('css');
  });

  it('path traversal /../package.json returns 400 or 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard/%2e%2e/%2e%2e/package.json`);
    expect([400, 404].includes(res.status)).toBe(true);
  });
}, TIMEOUT_MS);
