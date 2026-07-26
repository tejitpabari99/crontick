import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createClient } from '../src/client.js';
import { CrontickError } from '../src/errors.js';
import type { JobInput } from '../src/schemas/job.js';
import { jobJsonSchemaText } from '../src/schema-json.js';

const DAEMON_SCRIPT = resolve('dist', 'daemon', 'index.js');
const scratchRoot = resolve('.crontick', 'client-tests');
let previousHome: string | undefined;
let previousUrl: string | undefined;
let currentHome: string | undefined;
const cleanupFns: Array<() => Promise<void> | void> = [];

const testJob = {
  id: 'client-test-job',
  schedule: { kind: 'cron', cron: '0 0 * * *' },
  action: { kind: 'exec', command: 'echo', args: ['hello'] },
} satisfies JobInput;

function makeHome(): string {
  mkdirSync(scratchRoot, { recursive: true });
  const home = join(scratchRoot, randomUUID());
  mkdirSync(join(home, 'jobs'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
  previousHome = process.env['CRONTICK_HOME'];
  previousUrl = process.env['CRONTICK_DAEMON_URL'];
  process.env['CRONTICK_HOME'] = home;
  delete process.env['CRONTICK_DAEMON_URL'];
  currentHome = home;
  return home;
}

function writeFakeApiDaemon(home: string): string {
  const script = join(home, 'fake-api-daemon.mjs');
  writeFileSync(script, `
import http from 'node:http';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.CRONTICK_HOME;
mkdirSync(join(home, 'jobs'), { recursive: true });
mkdirSync(join(home, 'logs'), { recursive: true });
const jobs = new Map();
const runs = new Map();
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      resolve(raw ? JSON.parse(raw) : {});
    });
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') {
    const port = server.address() && typeof server.address() === 'object' ? server.address().port : 0;
    return json(res, 200, { ok: true, product: 'crontick', pid: process.pid, port });
  }
  if (req.method === 'GET' && url.pathname === '/api/daemon/status') return json(res, 200, { pid: process.pid, version: 'test', uptimeSec: 1, jobs: jobs.size });
  if (req.method === 'POST' && url.pathname === '/api/daemon/reload') return json(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/api/jobs') return json(res, 200, [...jobs.values()]);
  if (req.method === 'POST' && url.pathname === '/api/jobs') {
    const body = await readBody(req);
    jobs.set(body.id, body);
    return json(res, 201, body);
  }
  const jobMatch = url.pathname.match(/^\\/api\\/jobs\\/([^/]+)(\\/.*)?$/);
  if (jobMatch) {
    const id = decodeURIComponent(jobMatch[1]);
    const sub = jobMatch[2] ?? '';
    const job = jobs.get(id);
    if (!job) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
    if (req.method === 'GET' && sub === '') return json(res, 200, job);
    if (req.method === 'PUT' && sub === '') {
      const body = await readBody(req);
      const updated = { ...job, ...body, id };
      jobs.set(id, updated);
      return json(res, 200, updated);
    }
    if (req.method === 'DELETE' && sub === '') {
      jobs.delete(id);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && sub === '/enable') {
      const updated = { ...job, enabled: true };
      jobs.set(id, updated);
      return json(res, 200, updated);
    }
    if (req.method === 'POST' && sub === '/disable') {
      const updated = { ...job, enabled: false };
      jobs.set(id, updated);
      return json(res, 200, updated);
    }
    if (req.method === 'POST' && sub === '/run') {
      const runId = 'run-' + Math.random().toString(16).slice(2);
      runs.set(runId, { id: runId, jobId: id, status: 'queued', startedAt: Date.now() });
      return json(res, 202, { runId });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/runs') return json(res, 200, [...runs.values()]);
  const runMatch = url.pathname.match(/^\\/api\\/runs\\/([^/]+)(\\/.*)?$/);
  if (runMatch) {
    const runId = decodeURIComponent(runMatch[1]);
    if (runMatch[2] === '/cancel' && req.method === 'POST') {
      const run = runs.get(runId) ?? { id: runId, status: 'queued' };
      runs.set(runId, { ...run, status: 'canceled' });
      return json(res, 200, { ok: true, canceled: true });
    }
    if (runMatch[2] === '/logs') return json(res, 200, [{ runId, stream: 'stdout', ts: Date.now(), data: 'ok\\n' }]);
    return json(res, 200, runs.get(runId) ?? { id: runId, status: 'queued' });
  }
  if (req.method === 'GET' && url.pathname === '/api/stats/summary') return json(res, 200, { totalJobs: jobs.size, enabledJobs: [...jobs.values()].filter(j => j.enabled !== false).length, totalRuns: runs.size, succeeded: 0, failed: 0, avgDurationMs: null });
  const statsMatch = url.pathname.match(/^\\/api\\/stats\\/jobs\\/([^/]+)$/);
  if (req.method === 'GET' && statsMatch) return json(res, 200, { jobId: decodeURIComponent(statsMatch[1]), totalRuns: 0, succeeded: 0, failed: 0, lastStatus: null, lastRunAt: null });
  if (req.method === 'GET' && url.pathname === '/api/dashboard/status') {
    const port = server.address() && typeof server.address() === 'object' ? server.address().port : 0;
    return json(res, 200, { ok: true, running: true, url: 'http://127.0.0.1:' + port + '/dashboard', port, pid: process.pid, daemon: { pid: process.pid } });
  }
  if (req.method === 'GET' && url.pathname === '/api/dashboard') {
    return json(res, 200, {
      generatedAt: Date.now(),
      health: { ok: true, product: 'crontick', version: 'test', uptimeSec: 1, pid: process.pid, port: 0, node: process.versions.node, platform: process.platform, jobs: { total: jobs.size, enabled: jobs.size }, runs: { last24h: runs.size, failures24h: 0 } },
      stats: { totalJobs: jobs.size, enabledJobs: jobs.size, totalRuns: runs.size, succeeded: 0, failed: 0, avgDurationMs: null },
      jobs: [...jobs.values()].map((job) => ({ id: job.id, description: job.description ?? null, enabled: job.enabled !== false, scheduleLabel: job.schedule?.cron ?? 'schedule', actionKind: job.action?.kind ?? 'exec', lastStatus: null, lastRunAt: null, nextRunAt: null, job })),
      runs: [...runs.values()].map((run) => ({ ...run, endedAt: null, durationMs: null, exitCode: null, error: null })),
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/export') return json(res, 200, { jobs: [...jobs.values()] });
  if (req.method === 'POST' && url.pathname === '/api/import') {
    const body = await readBody(req);
    for (const job of body.jobs ?? []) jobs.set(job.id, job);
    return json(res, 200, { imported: (body.jobs ?? []).length });
  }
  if (req.method === 'POST' && url.pathname === '/api/schedules/validate') return json(res, 200, { ok: true });
  if (req.method === 'POST' && url.pathname === '/api/schedules/preview') return json(res, 200, { next: [] });
  json(res, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
});
function cleanup() {
  try { unlinkSync(join(home, 'daemon.port')); } catch {}
  try { unlinkSync(join(home, 'daemon.pid')); } catch {}
}
server.listen(0, '127.0.0.1', () => {
  const port = server.address() && typeof server.address() === 'object' ? server.address().port : 0;
  writeFileSync(join(home, 'daemon.pid'), String(process.pid), 'utf-8');
  writeFileSync(join(home, 'daemon.port'), String(port), 'utf-8');
});
process.on('SIGTERM', () => { cleanup(); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { cleanup(); server.close(() => process.exit(0)); });
`, 'utf-8');
  return script;
}

async function startHealthOnlyServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    res.end(JSON.stringify({ ok: true, product: 'crontick', pid: process.pid, port }));
  });
  await new Promise<void>((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const close = () => new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  cleanupFns.push(close);
  return { baseUrl: `http://127.0.0.1:${port}`, close };
}

async function closedPortUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return `http://127.0.0.1:${port}`;
}

function killHomeDaemon(home: string): void {
  const pidPath = join(home, 'daemon.pid');
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, 'utf-8'));
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }
}

afterEach(async () => {
  for (const fn of cleanupFns.splice(0)) await fn();
  if (currentHome) {
    killHomeDaemon(currentHome);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    rmSync(currentHome, { recursive: true, force: true });
    currentHome = undefined;
  }
  if (previousHome === undefined) delete process.env['CRONTICK_HOME'];
  else process.env['CRONTICK_HOME'] = previousHome;
  if (previousUrl === undefined) delete process.env['CRONTICK_DAEMON_URL'];
  else process.env['CRONTICK_DAEMON_URL'] = previousUrl;
});

describe('CrontickClient', () => {
  it('auto-starts the daemon for daemon-backed methods', async () => {
    const home = makeHome();
    const client = createClient({ daemonScript: writeFakeApiDaemon(home), startupTimeoutMs: 5_000 });

    await expect(client.listJobs()).resolves.toEqual([]);

    expect(existsSync(join(home, 'daemon.port'))).toBe(true);
    expect(existsSync(join(home, 'daemon.pid'))).toBe(true);
  });

  it('defaults daemonScript to the real dist/daemon/index.js when the caller supplies none (bare createClient against the built dist/index.js, matching the README quick start)', async () => {
    const home = makeHome();
    const script = join(home, 'bare-client.mjs');
    const distIndexUrl = pathToFileURL(resolve('dist', 'index.js')).href;
    writeFileSync(script, `
import { createClient } from ${JSON.stringify(distIndexUrl)};
const client = createClient({ startupTimeoutMs: 10_000 });
const created = await client.createJob({
  id: 'bare-default-daemon-script-job',
  schedule: { kind: 'cron', cron: '0 0 * * *' },
  action: { kind: 'exec', command: 'echo', args: ['hello'] },
});
process.stdout.write(JSON.stringify({ id: created.id }));
`);
    const result = spawnSync(process.execPath, [script], { encoding: 'utf-8', env: { ...process.env } });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ id: 'bare-default-daemon-script-job' });
    expect(existsSync(join(home, 'daemon.port'))).toBe(true);
  }, 15_000);

  it('keeps health and daemonStatus no-start by default', async () => {
    const home = makeHome();
    const client = createClient({ daemonScript: join(home, 'missing.mjs') });

    await expect(client.health({ ensure: false })).rejects.toMatchObject({ code: 'DAEMON_NOT_RUNNING' });
    await expect(client.daemonStatus()).rejects.toMatchObject({ code: 'DAEMON_NOT_RUNNING' });
    expect(existsSync(join(home, 'daemon.port'))).toBe(false);
    expect(existsSync(join(home, 'daemon.pid'))).toBe(false);
  });

  it('reports actionable dashboard daemon-down errors without starting', async () => {
    const home = makeHome();
    const client = createClient({ daemonScript: join(home, 'missing.mjs') });

    await expect(client.dashboardStatus()).rejects.toMatchObject({
      code: 'DAEMON_NOT_RUNNING',
      message: expect.stringContaining('crontick dashboard start'),
    });
    await expect(client.dashboardData()).rejects.toMatchObject({
      code: 'DAEMON_NOT_RUNNING',
      message: expect.stringContaining('crontick dashboard start'),
    });
    expect(existsSync(join(home, 'daemon.port'))).toBe(false);
  });

  it('includes the probed dashboard port when a configured daemon URL is unreachable', async () => {
    makeHome();
    const baseUrl = await closedPortUrl();
    const client = createClient({ daemonUrl: baseUrl, startDaemon: false, requestTimeoutMs: 200 });

    await expect(client.dashboardStatus()).rejects.toMatchObject({
      code: 'DAEMON_REQUEST_FAILED',
      message: expect.stringContaining(`${baseUrl}/api/dashboard/status`),
    });
  });

  it('validates create/import jobs before posting', async () => {
    makeHome();
    const server = await startHealthOnlyServer();
    const client = createClient({ daemonUrl: server.baseUrl, startDaemon: false });

    await expect(client.createJob({ ...testJob, id: 'not valid' })).rejects.toBeInstanceOf(Error);
    await expect(client.importJobs([{ ...testJob, id: 'also invalid' }])).rejects.toBeInstanceOf(Error);
  });

  it('supports common CRUD and helper methods through the HTTP API', async () => {
    const home = makeHome();
    const client = createClient({ daemonScript: writeFakeApiDaemon(home), startupTimeoutMs: 5_000 });

    await expect(client.createJob(testJob)).resolves.toMatchObject({ id: testJob.id });
    await expect(client.listJobs()).resolves.toHaveLength(1);
    await expect(client.getJob(testJob.id)).resolves.toMatchObject({ id: testJob.id });
    await expect(client.disableJob(testJob.id)).resolves.toMatchObject({ enabled: false });
    await expect(client.enableJob(testJob.id)).resolves.toMatchObject({ enabled: true });
    await expect(client.updateJob(testJob.id, { description: 'updated' })).resolves.toMatchObject({ description: 'updated' });
    const run = await client.runNow(testJob.id);
    expect(run.runId).toMatch(/^run-/);
    await expect(client.getRun(run.runId)).resolves.toMatchObject({ id: run.runId });
    await expect(client.listRuns({ jobId: testJob.id })).resolves.toEqual(expect.any(Array));
    await expect(client.cancelRun(run.runId)).resolves.toMatchObject({ ok: true, canceled: true });
    await expect(client.getLogs(run.runId)).resolves.toMatchObject({ runId: run.runId, lines: expect.any(Array) });
    await expect(client.statsSummary()).resolves.toMatchObject({ totalJobs: expect.any(Number) });
    await expect(client.statsJob(testJob.id)).resolves.toMatchObject({ jobId: testJob.id });
    await expect(client.exportJobs()).resolves.toMatchObject({ jobs: expect.any(Array) });
    await expect(client.importJobs([{ ...testJob, id: 'imported-client-job' }])).resolves.toMatchObject({ imported: 1 });
    await expect(client.validateSchedule(testJob.schedule)).resolves.toMatchObject({ ok: true });
    await expect(client.previewSchedule({ schedule: testJob.schedule, n: 1 })).resolves.toMatchObject({ next: [] });
    await expect(client.daemonReload()).resolves.toMatchObject({ ok: true });
    await expect(client.dashboardStart()).resolves.toMatchObject({ ok: true, running: true, startedDaemon: false });
    await expect(client.dashboardStatus()).resolves.toMatchObject({ ok: true, running: true });
    await expect(client.dashboardData({ runsLimit: 5 })).resolves.toMatchObject({ stats: { totalJobs: expect.any(Number) } });
    await expect(client.deleteJob(testJob.id)).resolves.toMatchObject({ ok: true });
  });


  it('exposes doctor and daemon lifecycle helpers', async () => {
    const home = makeHome();
    const client = createClient({ daemonScript: writeFakeApiDaemon(home), startupTimeoutMs: 5_000 });

    const started = await client.daemonStart();
    expect(started.ok).toBe(true);
    expect(started.port).toBeGreaterThan(0);
    await expect(client.daemonStatus()).resolves.toMatchObject({ pid: expect.any(Number) });

    const doctor = await client.doctor({ checkMcpHelp: false });
    expect(Array.isArray(doctor.checks)).toBe(true);
    expect(doctor.checks.some((check) => check.name === 'daemon reachable')).toBe(true);

    const stopped = await client.daemonStop();
    expect(stopped.ok).toBe(true);
    expect(stopped.pid).toBeGreaterThan(0);
  });

  it('normalizes prompt jobs and promptFile before posting', async () => {
    const home = makeHome();
    const promptPath = join(home, 'prompt.txt');
    writeFileSync(promptPath, 'client prompt', 'utf-8');
    const client = createClient({
      daemonScript: writeFakeApiDaemon(home),
      startupTimeoutMs: 5_000,
      cwd: home,
    });
    const created = await client.createJob({
      id: 'client-prompt-job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', promptFile: 'prompt.txt', engine: 'agency', args: ['--silent'] },
    });
    expect(created.action).toMatchObject({
      kind: 'prompt',
      prompt: 'client prompt',
      engine: 'agency',
      args: ['--silent'],
    });
    expect(created.action).not.toHaveProperty('promptFile');

    await expect(
      client.updateJob('client-prompt-job', {
        action: { kind: 'prompt', prompt: 'updated', reuseSession: true },
      }),
    ).resolves.toMatchObject({
      action: { kind: 'prompt', prompt: 'updated', reuseSession: true },
    });

    await expect(
      client.importJobs([
        {
          id: 'client-import-prompt-job',
          schedule: { kind: 'cron', cron: '0 10 * * *' },
          action: { kind: 'prompt', promptFile: promptPath },
        },
      ]),
    ).resolves.toMatchObject({ imported: 1 });
  });

  it('exposes session precedence notices through the public client', async () => {
    const home = makeHome();
    const client = createClient({
      daemonScript: writeFakeApiDaemon(home),
      startupTimeoutMs: 5_000,
    });

    const created = await client.createJob({
      id: 'client-session-precedence-job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'hello', sessionId: 'sess-client1', reuseSession: true },
    });

    expect(created.action).toMatchObject({
      kind: 'prompt',
      sessionId: 'sess-client1',
      reuseSession: false,
    });
    expect(client.drainNotices()).toEqual([expect.stringContaining('reuseSession was ignored')]);
  });

  it('writes the core-generated per-job schema sidecar through the public client', async () => {
    const home = makeHome();
    const client = createClient({ daemonScript: DAEMON_SCRIPT, startupTimeoutMs: 10_000 });

    await client.createJob({ ...testJob, id: 'client-schema-job' });

    expect(readFileSync(join(home, 'jobs', 'client-schema-job.schema.json'), 'utf-8')).toBe(jobJsonSchemaText());
  }, 15_000);

  it('surfaces API errors as CrontickError', async () => {
    const home = makeHome();
    const client = createClient({ daemonScript: writeFakeApiDaemon(home), startupTimeoutMs: 5_000 });

    await expect(client.getJob('missing-job')).rejects.toBeInstanceOf(CrontickError);
    await expect(client.getJob('missing-job')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
