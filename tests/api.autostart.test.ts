/**
 * Daemon HTTP API tests for autostart endpoints.
 * Spawns a real daemon with a temp CRONTICK_HOME and exercises:
 *   GET /api/autostart/status
 *   POST /api/autostart/install
 *   POST /api/autostart/remove
 *   HTTP 501 for darwin/linux backends
 *
 * This file writes to the real HKCU\Software\Microsoft\Windows\CurrentVersion\Run
 * under a scratch value name. It is gated to CI (process.env.CI) or
 * CRONTICK_RUN_REGISTRY_TESTS=1 so local `npm test` runs do not trigger EDR/MDE
 * persistence alerts on developer machines. GitHub Actions sets CI=true automatically.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

const DAEMON_SCRIPT = resolve('dist/daemon/index.js');
const TIMEOUT_MS = 30_000;
const runRealRegistryTests = !!process.env['CI'] || process.env['CRONTICK_RUN_REGISTRY_TESTS'] === '1';

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'crontick-autost-'));
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
        } catch { /* mid-write */ }
      }
      attempts++;
      if (attempts >= maxAttempts) {
        const stderr = getStderr?.() ?? '';
        return reject(new Error(`Daemon timed out${stderr ? `\n${stderr}` : ''}`));
      }
      setTimeout(check, 250);
    };
    check();
  });
}

async function apiCall(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
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

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Daemon autostart API', () => {
  let dir: string;
  let daemonProc: ChildProcess;
  let port: number;

  // Use a test-specific registry value name (win32 only) to avoid touching real autostart
  const testValueName = `crontick-daemon-test-${process.pid}`;

  beforeAll(async () => {
    dir = makeTmpDir();
    const stderrChunks: string[] = [];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CRONTICK_HOME: dir,
      CRONTICK_AUTOSTART_TEST_VALUE: testValueName,
      CRONTICK_DAEMON_BINARY: 'dist\\daemon\\index.js',
    };
    daemonProc = spawn(process.execPath, [DAEMON_SCRIPT], { env, stdio: 'pipe' });
    daemonProc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));
    port = await waitForPortFile(dir, 30_000, () => stderrChunks.join(''));
  }, TIMEOUT_MS);

  afterAll(async () => {
    // Cleanup win32 registry test value
    if (process.platform === 'win32' && runRealRegistryTests) {
      try {
        await apiCall(port, 'POST', '/api/autostart/remove', {});
      } catch { /* ignore */ }
    }
    daemonProc?.kill('SIGTERM');
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── status (always works) ─────────────────────────────────────────────────

  it('GET /api/autostart/status returns 200 with installed + backend', async () => {
    const { status, data } = await apiCall(port, 'GET', '/api/autostart/status');
    expect(status).toBe(200);
    const d = data as Record<string, unknown>;
    expect(typeof d['installed']).toBe('boolean');
    expect(['win32', 'darwin', 'linux', 'manual']).toContain(d['backend']);
  });

  // ── 501 for darwin / linux forced backends ────────────────────────────────

  it('GET /api/autostart/status?backend=darwin returns 501', async () => {
    const { status, data } = await apiCall(port, 'GET', '/api/autostart/status?backend=darwin');
    expect(status).toBe(501);
    const d = data as Record<string, unknown>;
    expect((d['error'] as Record<string, unknown>)?.['code']).toBe('NOT_IMPLEMENTED_V1');
  });

  it('GET /api/autostart/status?backend=linux returns 501', async () => {
    const { status } = await apiCall(port, 'GET', '/api/autostart/status?backend=linux');
    expect(status).toBe(501);
  });

  it('POST /api/autostart/install with backend:darwin returns 501', async () => {
    const { status, data } = await apiCall(port, 'POST', '/api/autostart/install', { backend: 'darwin' });
    expect(status).toBe(501);
    const d = data as Record<string, unknown>;
    expect((d['error'] as Record<string, unknown>)?.['code']).toBe('NOT_IMPLEMENTED_V1');
  });

  it('POST /api/autostart/install with backend:linux returns 501', async () => {
    const { status } = await apiCall(port, 'POST', '/api/autostart/install', { backend: 'linux' });
    expect(status).toBe(501);
  });

  // ── win32 round-trip (Windows only) ──────────────────────────────────────

  describe.skipIf(process.platform !== 'win32' || !runRealRegistryTests)('win32 round-trip (real registry)', () => {
    it('status → install → status (installed) → remove → status (not installed)', async () => {
      const s1 = await apiCall(port, 'GET', `/api/autostart/status?backend=win32`);
      expect((s1.data as Record<string, unknown>)['installed']).toBe(false);

      const install = await apiCall(port, 'POST', '/api/autostart/install', {});
      expect(install.status).toBe(200);
      expect((install.data as Record<string, unknown>)['ok']).toBe(true);

      const s2 = await apiCall(port, 'GET', `/api/autostart/status?backend=win32`);
      expect((s2.data as Record<string, unknown>)['installed']).toBe(true);

      const remove = await apiCall(port, 'POST', '/api/autostart/remove', {});
      expect(remove.status).toBe(200);

      const s3 = await apiCall(port, 'GET', `/api/autostart/status?backend=win32`);
      expect((s3.data as Record<string, unknown>)['installed']).toBe(false);
    });
  });
});
