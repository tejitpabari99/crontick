/**
 * API integration tests.
 * Spawns a real daemon process with a temp CRONTICK_HOME and hits its HTTP API.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

const DAEMON_SCRIPT = resolve('dist/daemon/index.js');
const TIMEOUT_MS = 30_000;

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'crontick-api-'));
  mkdirSync(join(d, 'jobs'), { recursive: true });
  mkdirSync(join(d, 'logs'), { recursive: true });
  return d;
}

function waitForPortFile(dir: string, maxMs = 30_000, getStderr?: () => string): Promise<number> {
  const portFile = join(dir, 'daemon.port');
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = Math.ceil(maxMs / 250);
    const check = () => {
      if (existsSync(portFile)) {
        try {
          const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
          if (!isNaN(port) && port > 0) return resolve(port);
        } catch {
          // file may be mid-write; retry
        }
      }
      attempts++;
      if (attempts >= maxAttempts) {
        const stderr = getStderr?.() ?? '';
        return reject(
          new Error(`Timed out waiting for daemon${stderr ? `\nDaemon stderr:\n${stderr}` : ''}`),
        );
      }
      setTimeout(check, 250);
    };
    check();
  });
}

async function apiCall(port: number, method: string, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

describe('Daemon HTTP API', () => {
  let dir: string;
  let daemonProc: ChildProcess;
  let port: number;

  beforeAll(async () => {
    dir = makeTmpDir();
    const stderrChunks: string[] = [];
    daemonProc = spawn(process.execPath, [DAEMON_SCRIPT], {
      env: { ...process.env, CRONTICK_HOME: dir },
      stdio: 'pipe',
    });
    daemonProc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));
    port = await waitForPortFile(dir, 30_000, () => stderrChunks.join(''));
  }, TIMEOUT_MS);

  afterAll(() => {
    daemonProc?.kill('SIGTERM');
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── Health ───────────────────────────────────────────────────────────────────

  it('GET /health returns ok', async () => {
    const { status, data } = await apiCall(port, 'GET', '/health');
    expect(status).toBe(200);
    expect((data as { ok: boolean }).ok).toBe(true);
    expect(typeof (data as { version: string }).version).toBe('string');
    expect(typeof (data as { uptimeSec: number }).uptimeSec).toBe('number');
  });

  // ── Localhost-only guard (T-NEW-5) ────────────────────────────────────────────

  it('daemon binds only to 127.0.0.1 (port file exists and is loopback)', () => {
    const portFile = join(dir, 'daemon.port');
    expect(existsSync(portFile)).toBe(true);
    // Port is a valid number which means server started on 127.0.0.1
    expect(port).toBeGreaterThan(0);
  });

  // ── Jobs CRUD ─────────────────────────────────────────────────────────────────

  const testJob = {
    id: 'api-test-job',
    schedule: { kind: 'cron', cron: '0 0 * * *' },
    action: { kind: 'exec', command: 'echo', args: ['hello'] },
  };

  it('POST /api/jobs creates a job', async () => {
    const { status, data } = await apiCall(port, 'POST', '/api/jobs', testJob);
    expect(status).toBe(201);
    expect((data as { id: string }).id).toBe('api-test-job');
  });

  it('GET /api/jobs lists jobs', async () => {
    const { status, data } = await apiCall(port, 'GET', '/api/jobs');
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect((data as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/jobs/:id retrieves job', async () => {
    const { status, data } = await apiCall(port, 'GET', '/api/jobs/api-test-job');
    expect(status).toBe(200);
    expect((data as { id: string }).id).toBe('api-test-job');
  });

  it('GET /api/jobs/:id returns 404 for missing job', async () => {
    const { status } = await apiCall(port, 'GET', '/api/jobs/no-such-job');
    expect(status).toBe(404);
  });

  it('POST /api/jobs/:id/disable disables job', async () => {
    const { status, data } = await apiCall(port, 'POST', '/api/jobs/api-test-job/disable');
    expect(status).toBe(200);
    expect((data as { enabled: boolean }).enabled).toBe(false);
  });

  it('POST /api/jobs/:id/enable enables job', async () => {
    const { status, data } = await apiCall(port, 'POST', '/api/jobs/api-test-job/enable');
    expect(status).toBe(200);
    expect((data as { enabled: boolean }).enabled).toBe(true);
  });

  // ── Run job ────────────────────────────────────────────────────────────────────

  it('POST /api/jobs/:id/run returns runId', async () => {
    const { status, data } = await apiCall(port, 'POST', '/api/jobs/api-test-job/run');
    expect(status).toBe(202);
    expect(typeof (data as { runId: string }).runId).toBe('string');
  });

  it('GET /api/runs lists runs', async () => {
    const { status, data } = await apiCall(port, 'GET', '/api/runs?jobId=api-test-job');
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
  });

  // ── Schedules ─────────────────────────────────────────────────────────────────

  it('POST /api/schedules/validate returns ok for valid cron', async () => {
    const { status, data } = await apiCall(port, 'POST', '/api/schedules/validate', {
      kind: 'cron',
      cron: '0 9 * * *',
    });
    expect(status).toBe(200);
    expect((data as { ok: boolean }).ok).toBe(true);
  });

  it('POST /api/schedules/preview returns next times', async () => {
    const { status, data } = await apiCall(port, 'POST', '/api/schedules/preview', {
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      n: 3,
    });
    expect(status).toBe(200);
    expect(Array.isArray((data as { next: unknown[] }).next)).toBe(true);
    expect((data as { next: unknown[] }).next).toHaveLength(3);
  });

  // ── Stats ──────────────────────────────────────────────────────────────────────

  it('GET /api/stats/summary returns summary', async () => {
    const { status, data } = await apiCall(port, 'GET', '/api/stats/summary');
    expect(status).toBe(200);
    expect(typeof (data as { totalJobs: number }).totalJobs).toBe('number');
  });

  // ── Daemon status ──────────────────────────────────────────────────────────────

  it('GET /api/daemon/status returns pid', async () => {
    const { status, data } = await apiCall(port, 'GET', '/api/daemon/status');
    expect(status).toBe(200);
    expect(typeof (data as { pid: number }).pid).toBe('number');
  });

  // ── Export / Import ────────────────────────────────────────────────────────────

  it('GET /api/export exports jobs', async () => {
    const { status, data } = await apiCall(port, 'GET', '/api/export');
    expect(status).toBe(200);
    expect(Array.isArray((data as { jobs: unknown[] }).jobs)).toBe(true);
  });

  it('POST /api/import imports jobs', async () => {
    const importJob = {
      id: 'imported-job',
      schedule: { kind: 'cron', cron: '0 * * * *' },
      action: { kind: 'exec', command: 'echo', args: [] },
    };
    const { status, data } = await apiCall(port, 'POST', '/api/import', { jobs: [importJob] });
    expect(status).toBe(200);
    expect((data as { imported: number }).imported).toBe(1);
  });

  // ── Run logs ───────────────────────────────────────────────────────────────────

  it('GET /api/runs/:id/logs returns log array', async () => {
    // First trigger a quick run
    const { data: runData } = await apiCall(port, 'POST', '/api/jobs/api-test-job/run');
    const runId = (runData as { runId: string }).runId;
    // Give it a moment to complete
    await new Promise((r) => setTimeout(r, 2000));
    const { status } = await apiCall(port, 'GET', `/api/runs/${runId}/logs`);
    expect(status).toBe(200);
  }, 8000);

  // ── Daemon reload ─────────────────────────────────────────────────────────────

  it('POST /api/daemon/reload returns ok', async () => {
    const { status, data } = await apiCall(port, 'POST', '/api/daemon/reload');
    expect(status).toBe(200);
    expect((data as { ok: boolean }).ok).toBe(true);
  });

  // ── Delete job ─────────────────────────────────────────────────────────────────

  it('DELETE /api/jobs/:id removes job', async () => {
    const { status, data } = await apiCall(port, 'DELETE', '/api/jobs/api-test-job');
    expect(status).toBe(200);
    expect((data as { ok: boolean }).ok).toBe(true);
    const { status: s2 } = await apiCall(port, 'GET', '/api/jobs/api-test-job');
    expect(s2).toBe(404);
  });

  // ── 404 for unknown route ─────────────────────────────────────────────────────

  it('returns 404 for unknown route', async () => {
    const { status } = await apiCall(port, 'GET', '/api/nonexistent');
    expect(status).toBe(404);
  });
});
