/**
 * Dashboard serving integration tests.
 * Starts a real daemon and tests the dashboard HTTP serving.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

const DAEMON_SCRIPT = resolve('dist/daemon/index.js');
const TIMEOUT_MS = 30_000;

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'crontick-dashboard-'));
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

describe('Dashboard serving', () => {
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
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
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
    const res = await fetch(`http://127.0.0.1:${port}/dashboard/../package.json`);
    expect([400, 404].includes(res.status)).toBe(true);
  });
}, TIMEOUT_MS);
