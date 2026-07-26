/**
 * Live-daemon scheduler auto-fire integration test.
 *
 * Every other daemon-level test in this suite (api.test.ts, cli.test.ts,
 * mcp.test.ts) triggers a run manually via POST /api/jobs/:id/run. None of
 * them let the real Scheduler inside a live daemon process fire a tick on its
 * own timer and turn that into a run record — which is the product's core
 * promise (jobs fire on their own, with no caller triggering them). This file
 * closes that gap for both interval and cron schedules.
 *
 * New file (not api.test.ts) because this needs its own short-lived daemon
 * instance polling on a live schedule, distinct from api.test.ts's long-lived
 * shared daemon serving ~30 unrelated CRUD tests.
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
  const d = mkdtempSync(join(tmpdir(), 'crontick-autofire-'));
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

/** Poll until at least `count` terminal runs for jobId are observed, or the deadline passes. */
async function pollForTerminalRunCount(port: number, jobId: string, count: number, maxMs: number): Promise<RunSummary[]> {
  const deadline = Date.now() + maxMs;
  const terminal = new Set(['success', 'failed', 'canceled', 'timeout']);
  for (;;) {
    const { data } = await apiCall(port, 'GET', `/api/runs?jobId=${jobId}`);
    const runs = data as RunSummary[];
    if (runs.filter((r) => terminal.has(r.status)).length >= count) return runs;
    if (Date.now() >= deadline) return runs;
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('Integration: live Scheduler auto-fires ticks into runs (no manual /run trigger)', () => {
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

  it('an interval job auto-fires through the live daemon Scheduler without any /run call', async () => {
    const jobId = 'autofire-interval-job';
    // Shortest safe interval — matches the existing real-timer Scheduler
    // convention (tests/scheduler.test.ts uses everySec: 1 for its real-timer
    // "fires" test). No startAt: the scheduler arms an initial ~1s delay,
    // then a real setInterval every 1s.
    const created = await apiCall(port, 'POST', '/api/jobs', {
      id: jobId,
      schedule: { kind: 'interval', everySec: 1 },
      action: { kind: 'exec', command: node, args: ['-e', 'process.exit(0)'] },
    });
    expect(created.status).toBe(201);

    // Poll-until-condition rather than a fixed sleep: wait for two
    // independent terminal runs to prove the scheduler fired more than
    // once on its own timer, not merely a single coincidental run. The
    // outer deadline is generous (well beyond the ~2-3s common case) so a
    // loaded CI runner doesn't flake — pollForTerminalRunCount still
    // returns as soon as the condition is met, so the common case isn't
    // slowed down.
    const runs = await pollForTerminalRunCount(port, jobId, 2, 20_000);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    for (const run of runs) {
      expect(run.status).toBe('success');
    }
  }, 25_000);

  it('a cron job (every-minute-equivalent short cron) auto-fires through the live daemon Scheduler', async () => {
    const jobId = 'autofire-cron-tick';
    // `* * * * * *` (6-field, seconds-resolution cron) is the shortest safe
    // real cron tick available without special-casing standard 5-field cron,
    // which has a 60s minimum granularity that would make this test far too
    // slow. Croner (the library backing the scheduler) supports the optional
    // leading seconds field.
    const created = await apiCall(port, 'POST', '/api/jobs', {
      id: jobId,
      schedule: { kind: 'cron', cron: '* * * * * *' },
      action: { kind: 'exec', command: node, args: ['-e', 'process.exit(0)'] },
    });
    expect(created.status).toBe(201);

    const runs = await pollForTerminalRunCount(port, jobId, 1, 20_000);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe('success');
  }, 25_000);
});
