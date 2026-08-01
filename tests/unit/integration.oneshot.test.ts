/**
 * One-shot job integration tests against a real, live daemon.
 * New file (not api.test.ts) because these tests need a multi-second scheduled
 * wait for the scheduler to auto-fire a one-shot job, which would otherwise
 * serialize behind api.test.ts's ~30 unrelated CRUD tests sharing one daemon.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

const DAEMON_SCRIPT = join(process.cwd(), 'dist', 'daemon', 'index.js');
const TIMEOUT_MS = 30_000;
const node = process.execPath;

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'crontick-oneshot-'));
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

interface RunSummary { id: string; jobId: string; status: string }

async function pollForTerminalRuns(port: number, jobId: string, maxMs: number): Promise<RunSummary[]> {
  const deadline = Date.now() + maxMs;
  const terminal = new Set(['success', 'failed', 'canceled', 'timeout']);
  for (;;) {
    const { data } = await apiCall(port, 'GET', `/api/runs?jobId=${jobId}`);
    const runs = data as RunSummary[];
    if (runs.some((r) => terminal.has(r.status))) return runs;
    if (Date.now() >= deadline) return runs;
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('Integration: one-shot jobs through a live daemon', () => {
  let dir: string;
  let daemonProc: ChildProcess;
  let port: number;

  beforeAll(async () => {
    dir = makeTmpDir();
    const stderrChunks: string[] = [];
    daemonProc = spawn(node, [DAEMON_SCRIPT], {
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

  it('fires exactly once, is never rescheduled, and survives a reload without refiring', async () => {
    const jobId = 'oneshot-fires-once';
    const runAt = new Date(Date.now() + 1500).toISOString();
    const created = await apiCall(port, 'POST', '/api/jobs', {
      id: jobId,
      schedule: { kind: 'one-shot', runAt },
      action: { kind: 'exec', command: node, args: ['-e', 'process.exit(0)'] },
    });
    expect(created.status).toBe(201);

    // Poll-until-terminal (not a fixed sleep) for the primary "it fires" assertion.
    const runs = await pollForTerminalRuns(port, jobId, 8000);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');

    // Job definition is not deleted after firing — only the scheduler's
    // internal timer entry is removed.
    const jobAfter = await apiCall(port, 'GET', `/api/jobs/${jobId}`);
    expect(jobAfter.status).toBe(200);

    // No-refire proof: a fixed, generous wait (proving an absence has no
    // condition to poll for) followed by a re-check that the run count is
    // still exactly 1.
    await new Promise((r) => setTimeout(r, 2000));
    const { data: afterWait } = await apiCall(port, 'GET', `/api/runs?jobId=${jobId}`);
    expect(afterWait as RunSummary[]).toHaveLength(1);

    // Reload does not resurrect a fired one-shot (scheduleOneShot recomputes
    // delay <= 0 and no-ops).
    const reload = await apiCall(port, 'POST', '/api/daemon/reload');
    expect(reload.status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    const { data: afterReload } = await apiCall(port, 'GET', `/api/runs?jobId=${jobId}`);
    expect(afterReload as RunSummary[]).toHaveLength(1);
  }, 15_000);

  it('a one-shot with a past runAt is silently skipped and never fires', async () => {
    const jobId = 'oneshot-past-skipped';
    const runAt = new Date(Date.now() - 3_600_000).toISOString();
    const created = await apiCall(port, 'POST', '/api/jobs', {
      id: jobId,
      schedule: { kind: 'one-shot', runAt },
      action: { kind: 'exec', command: node, args: ['-e', 'process.exit(0)'] },
    });
    expect(created.status).toBe(201);

    // Proving an absence is inherently time-bounded; scheduleOneShot's early
    // return for a past runAt is a synchronous Date comparison (no I/O), so a
    // generous fixed wait is safe here.
    await new Promise((r) => setTimeout(r, 1500));
    const { data: runs } = await apiCall(port, 'GET', `/api/runs?jobId=${jobId}`);
    expect(runs).toEqual([]);

    const job = await apiCall(port, 'GET', `/api/jobs/${jobId}`);
    expect(job.status).toBe(200);
    expect((job.data as { enabled: boolean }).enabled).toBe(true);
  }, 10_000);
});
