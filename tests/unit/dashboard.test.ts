/**
 * Core dashboard model + daemon dashboard serving tests.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { buildDashboardData, resolveDashboardAsset } from '../../src/dashboard.js';
import { Scheduler } from '../../src/daemon/scheduler.js';
import { Store } from '../../src/daemon/store.js';
import { CrontickError } from '../../src/errors.js';
import { teardownDaemon } from '../helpers/cleanup.js';
import type { Job } from '../../src/schemas/job.js';

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
      action: { kind: 'prompt', prompt: 'hello', args: [], reuseSession: false },
      overlap: 'skip',
      retry: { max: 0, backoffSec: 30 },
    } satisfies Job;
    store.upsertJob(job);
    scheduler.schedule(job);
    const run = store.insertRun(job.id, Date.now() - 1000);
    store.updateRun(run.id, { status: 'success', endedAt: Date.now(), durationMs: 25, exitCode: 0 });

    const data = buildDashboardData({ store, scheduler, startedAt: new Date(Date.now() - 5000), port: 12345, pid: 6789 }, { runsLimit: 10 });

    expect(data.health).toMatchObject({ ok: true, product: 'crontick', port: 12345, pid: 6789 });
    expect(data.stats).toMatchObject({ totalJobs: 1, enabledJobs: 1, succeeded: 1, failed: 0 });
    expect(data.jobs[0]).toMatchObject({ id: job.id, scheduleLabel: 'every 60s', actionKind: 'prompt', lastStatus: 'success' });
    expect(data.jobs[0].nextRunAt).toEqual(expect.any(String));
    expect(data.runs[0]).toMatchObject({ id: run.id, jobId: job.id, status: 'success', durationMs: 25, exitCode: 0 });
  });

  it('filters runs by multiple jobs/statuses and searches run fields and logs (q)', () => {
    dir = makeScratchDir('run-search');
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    scheduler = new Scheduler();
    store.open();
    const mk = (id: string, alias: string): Job => ({
      id,
      alias,
      enabled: true,
      schedule: { kind: 'interval', everySec: 60 },
      action: { kind: 'prompt', prompt: 'hello', args: [], reuseSession: false },
      overlap: 'skip',
      retry: { max: 0, backoffSec: 30 },
    });
    const a = mk('11111111-1111-4111-8111-111111111111', 'trial');
    const b = mk('22222222-2222-4222-8222-222222222222', 'sample');
    const c = mk('33333333-3333-4333-8333-333333333333', 'other');
    for (const j of [a, b, c]) store.upsertJob(j);
    const ra = store.insertRun(a.id, Date.now() - 3000);
    store.updateRun(ra.id, { status: 'success', durationMs: 10 });
    const rb = store.insertRun(b.id, Date.now() - 2000);
    store.updateRun(rb.id, { status: 'failed', durationMs: 20, error: '100% broken_thing' });
    const rc = store.insertRun(c.id, Date.now() - 1000);
    store.updateRun(rc.id, { status: 'success', durationMs: 30 });
    store.setRunOutput(rc.id, { format: 'text', result: 'needle-in-the-haystack', engineError: null, stderr: '' });
    const ctx = { store, scheduler, startedAt: new Date(), port: 1 };
    const ids = (opts: Parameters<typeof buildDashboardData>[1]) => buildDashboardData(ctx, opts).runs.map((r) => r.id).sort();

    expect(ids({ jobIds: [a.id, b.id] })).toEqual([ra.id, rb.id].sort());
    expect(ids({ statuses: ['failed'] })).toEqual([rb.id]);
    expect(ids({ jobIds: [a.id, b.id], statuses: ['success'] })).toEqual([ra.id]);
    expect(ids({ q: 'needle' })).toEqual([rc.id]); // run output search
    expect(ids({ q: 'NEEDLE-in' })).toEqual([rc.id]); // case-insensitive
    expect(ids({ q: 'sample' })).toEqual([rb.id]); // job alias
    expect(ids({ q: 'failed' })).toEqual([rb.id]); // status
    expect(ids({ q: '100%' })).toEqual([rb.id]); // error text, % matched literally
    expect(ids({ q: 'broken_thing' })).toEqual([rb.id]);
    expect(ids({ q: '%' })).toEqual([rb.id]); // a bare wildcard is literal, not match-all
    expect(ids({ q: "x'; DROP TABLE runs;--" })).toEqual([]); // bound, not interpolated
    expect(ids({ q: ra.id.slice(0, 8) })).toEqual([ra.id]);
    expect(store.listRuns({ q: 'needle' })).toHaveLength(1);
  });

  it('rejects dashboard asset traversal in the core resolver', () => {
    expect(() => resolveDashboardAsset('/dashboard/../../package.json')).toThrow(CrontickError);
  });

  // Minor 5: avgDurationMs previously divided total duration by runs.length,
  // which counts every row including 'missed'/'queued'/'running'/'canceled'
  // ones whose durationMs is 0 — up to 500 missed rows could drag the
  // reported average toward zero. It must instead average only over runs
  // that actually executed to completion.
  it('excludes missed/queued/running/canceled/skipped runs from avgDurationSec (Minor 5)', () => {
    dir = makeScratchDir('avg-duration');
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    scheduler = new Scheduler();
    store.open();
    const job = {
      id: 'avg-duration-job',
      enabled: true,
      schedule: { kind: 'interval', everySec: 60 },
      action: { kind: 'prompt', prompt: 'hello', args: [], reuseSession: false },
      overlap: 'skip',
      retry: { max: 0, backoffSec: 30 },
    } satisfies Job;
    store.upsertJob(job);
    scheduler.schedule(job);

    // Two executed runs averaging 100ms...
    const ok1 = store.insertRun(job.id, Date.now() - 1000);
    store.updateRun(ok1.id, { status: 'success', endedAt: Date.now(), durationMs: 50, exitCode: 0 });
    const ok2 = store.insertRun(job.id, Date.now() - 1000);
    store.updateRun(ok2.id, { status: 'failed', endedAt: Date.now(), durationMs: 150, exitCode: 1 });

    // ...swamped by non-executed rows with durationMs 0, which must not
    // count toward the average or its denominator.
    for (let i = 0; i < 20; i++) {
      const missed = store.insertRun(job.id, Date.now() - 1000);
      store.updateRun(missed.id, { status: 'missed', durationMs: 0 });
    }
    const queued = store.insertRun(job.id, Date.now() - 1000);
    store.updateRun(queued.id, { status: 'queued', durationMs: 0 });
    const running = store.insertRun(job.id, Date.now() - 1000);
    store.updateRun(running.id, { status: 'running' });
    const canceled = store.insertRun(job.id, Date.now() - 1000);
    store.updateRun(canceled.id, { status: 'canceled', durationMs: 0 });
    const skipped = store.insertRun(job.id, Date.now() - 1000);
    store.updateRun(skipped.id, { status: 'skipped', durationMs: 0 });

    const data = buildDashboardData({ store, scheduler, startedAt: new Date(Date.now() - 5000), port: 12345, pid: 6789 }, { runsLimit: 100 });

    // (50 + 150) / 2 = 100 — not dragged toward 0 by the 23 non-executed rows.
    expect(data.stats).not.toHaveProperty('avgDurationMs');
    expect(data.stats.avgDurationSec).toBe(0.1);
    expect(data.stats).not.toHaveProperty('totalRuns');
    expect(data.stats).toMatchObject({ canceled: 1, skipped: 1 });
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
    await teardownDaemon(daemonProc, dir);
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

  it('serves the dashboard UI wired to the run-now, output and search APIs', async () => {
    const html = await (await fetch(`http://127.0.0.1:${port}/dashboard`)).text();
    const js = await (await fetch(`http://127.0.0.1:${port}/dashboard/dashboard.js`)).text();
    expect(html).not.toContain('id="sort-runs"');
    expect(html).toContain('data-sort="started"');
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('id="auto-refresh"');
    for (const sec of ['10', '15', '30', '60']) expect(html).toContain(`data-sec="${sec}"`);
    expect(js).toContain('/run-now');
    expect(js).toContain('/output');
    expect(js).toContain('avgDurationSec');
    expect(js).not.toContain('avgDurationMs');
  });

  it('serves a light/dark theme toggle backed by CSS custom properties', async () => {
    const html = await (await fetch(`http://127.0.0.1:${port}/dashboard`)).text();
    const css = await (await fetch(`http://127.0.0.1:${port}/dashboard/dashboard.css`)).text();
    const js = await (await fetch(`http://127.0.0.1:${port}/dashboard/dashboard.js`)).text();
    expect(html).toContain('id="theme-toggle"');
    for (const c of ['system', 'light', 'dark']) expect(html).toContain(`data-theme-choice="${c}"`);
    // The saved theme is applied by an inline script in <head> before the stylesheet loads.
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain("localStorage.getItem('crontick.theme')");
    expect(head.indexOf('data-theme')).toBeLessThan(head.indexOf('dashboard.css'));
    expect(css).toMatch(/:root\s*\{[^}]*--bg:/);
    expect(css).toContain('prefers-color-scheme: light');
    expect(css).toContain(':root[data-theme="light"]');
    expect(css.split("\n").filter((l) => /rgba\(/.test(l) && !l.trim().startsWith("--"))).toEqual([]);
    expect(js).toContain('data-theme');
    expect(js).toContain('crontick.theme');
  });

  it('GET /api/runs and /api/dashboard accept multi-value jobId/status and q', async () => {
    for (const path of ['/api/runs?jobId=a,b&status=failed,success&q=x%25y', '/api/dashboard?jobId=a,b&status=failed,success&q=needle']) {
      const { status } = await apiCall(port, 'GET', path);
      expect(status).toBe(200);
    }
  });

  it('path traversal /../package.json returns 400 or 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard/%2e%2e/%2e%2e/package.json`);
    expect([400, 404].includes(res.status)).toBe(true);
  });
}, TIMEOUT_MS);
