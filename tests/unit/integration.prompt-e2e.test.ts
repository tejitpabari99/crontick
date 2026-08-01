/**
 * Prompt-job integration test against a real, live daemon, using a stub
 * "prompt engine" (a tiny node -e script) instead of a real external CLI
 * binary. New file (not api.test.ts) because the daemon must be spawned with
 * a bespoke config.json written into CRONTICK_HOME *before* startup — the
 * daemon has no HTTP/CLI surface for registering engines at runtime, so this
 * cannot share api.test.ts's single pre-spawned daemon.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

const DAEMON_SCRIPT = join(process.cwd(), 'dist', 'daemon', 'index.js');
const TIMEOUT_MS = 30_000;
const node = process.execPath;
const STUB_SESSION_ID = 'sess-e2e12345';

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

describe('Integration: prompt job session capture through a live daemon', () => {
  let dir: string;
  let daemonProc: ChildProcess;
  let port: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crontick-prompt-e2e-'));
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });

    // Stub prompt engine: a plain node -e script standing in for a real
    // external CLI, so this test needs no real engine binary installed.
    // buildPromptRunCommand appends the prompt text (and job-level args)
    // after engine.args, so the extra argv entries are simply ignored by
    // this inline script.
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        defaultEngine: 'stub',
        engines: {
          stub: {
            command: node,
            args: ['-e', `console.log('session id: ${STUB_SESSION_ID}'); console.log('stub engine ran');`],
          },
        },
      }),
      'utf-8',
    );

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

  it('runs a one-shot prompt job through the stub engine, captures the session id, and persists it on the job', async () => {
    const jobId = 'prompt-e2e-job';
    const runAt = new Date(Date.now() + 500).toISOString();
    const created = await apiCall(port, 'POST', '/api/jobs', {
      id: jobId,
      schedule: { kind: 'one-shot', runAt },
      action: { kind: 'prompt', prompt: 'hello', engine: 'stub', args: [], reuseSession: true },
    });
    expect(created.status).toBe(201);

    const runs = await pollForTerminalRuns(port, jobId, 8000);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('success');

    const { data: logs } = await apiCall(port, 'GET', `/api/runs/${runs[0].id}/logs`);
    const stdoutText = (logs as Array<{ stream: string; data: string }>)
      .filter((l) => l.stream === 'stdout')
      .map((l) => l.data)
      .join('');
    expect(stdoutText).toContain('stub engine ran');
    expect(stdoutText).toContain(`[crontick] captured session id: ${STUB_SESSION_ID}`);

    // Session id captured from the stub's transcript is persisted onto the
    // job definition, and reuseSession flips false (capture-once semantics).
    const jobAfter = await apiCall(port, 'GET', `/api/jobs/${jobId}`);
    expect(jobAfter.status).toBe(200);
    const action = (jobAfter.data as { action: { sessionId?: string; reuseSession: boolean } }).action;
    expect(action.sessionId).toBe(STUB_SESSION_ID);
    expect(action.reuseSession).toBe(false);
  }, 15_000);
});
