/**
 * /health endpoint integration test.
 * Starts a real daemon and verifies the extended health shape.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

const DAEMON_SCRIPT = resolve('dist/daemon/index.js');
const TIMEOUT_MS = 30_000;

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'crontick-health-'));
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

describe('/health extended shape', () => {
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

  it('/health returns ok:true with extended fields', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(typeof body.uptimeSec).toBe('number');
    expect(typeof body.pid).toBe('number');
    expect(typeof body.port).toBe('number');
    expect(body.port).toBe(port);
    expect(body.jobs).toBeDefined();
    expect(typeof (body.jobs as Record<string, unknown>).total).toBe('number');
    expect(typeof (body.jobs as Record<string, unknown>).enabled).toBe('number');
    expect(body.runs).toBeDefined();
    expect(typeof (body.runs as Record<string, unknown>).last24h).toBe('number');
    expect(typeof (body.runs as Record<string, unknown>).failures24h).toBe('number');
    expect(typeof body.node).toBe('string');
    expect(typeof body.platform).toBe('string');
  });
}, TIMEOUT_MS);
