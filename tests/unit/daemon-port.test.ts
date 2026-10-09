/** Daemon port selection against real sockets: default/preferred port, occupied-port fallback, discovery via daemon.port. */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { stopDaemon } from '../../src/daemon/lifecycle.js';

const DAEMON_SCRIPT = join(process.cwd(), 'dist', 'daemon', 'index.js');

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function listenOn(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

async function freePort(): Promise<number> {
  const s = await listenOn(0);
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

function startDaemon(daemonPort: number): { dir: string; env: NodeJS.ProcessEnv; stderr: () => string; proc: ChildProcess } {
  const dir = mkdtempSync(join(tmpdir(), 'crontick-port-'));
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ daemon: { port: daemonPort } }));
  const env = { ...process.env, CRONTICK_HOME: dir };
  const chunks: string[] = [];
  const proc = spawn(process.execPath, [DAEMON_SCRIPT], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr!.on('data', (d: Buffer) => chunks.push(d.toString()));
  cleanups.push(async () => {
    await stopDaemon({ env }).catch(() => undefined);
    proc.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, env, stderr: () => chunks.join(''), proc };
}

async function waitForPort(dir: string): Promise<number> {
  const file = join(dir, 'daemon.port');
  for (let i = 0; i < 120; i++) {
    if (existsSync(file)) {
      const n = parseInt(readFileSync(file, 'utf-8'), 10);
      if (n > 0) return n;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('daemon did not write daemon.port');
}

/** Daemon errors land in a JSON log line, so backslashes (Windows paths) are doubled. */
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('daemon port', () => {
  it('binds the preferred port when it is free and records it in daemon.port', async () => {
    const preferred = await freePort();
    const d = startDaemon(preferred);
    expect(await waitForPort(d.dir)).toBe(preferred);
    expect(d.stderr()).not.toContain('is in use');
  });

  it('fails with DAEMON_PORT_IN_USE (no fallback) when a plain listener holds the explicit port', async () => {
    const blocker = await listenOn(0);
    const sockets = new Set<net.Socket>();
    blocker.on('connection', (sock) => {
      // The daemon probes it; sockets must be destroyed so close() resolves.
      // On Windows the probe's teardown can reset the connection (ECONNRESET), which would be an uncaught 'error'.
      sock.on('error', () => undefined);
      sockets.add(sock);
    });
    cleanups.push(() => new Promise<void>((r) => { sockets.forEach((sock) => sock.destroy()); blocker.close(() => r()); }));
    const preferred = (blocker.address() as net.AddressInfo).port;
    const d = startDaemon(preferred);
    const code = await new Promise<number | null>((r) => d.proc.once('exit', r));
    expect(code).not.toBe(0);
    expect(d.stderr()).toContain(`Port ${preferred} (config daemon.port) is in use by another process (not crontick)`);
    expect(existsSync(join(d.dir, 'daemon.port'))).toBe(false);
  });

  it('names the holder when another crontick daemon (other data dir) owns the explicit port', async () => {
    const first = startDaemon(await freePort());
    const firstPort = await waitForPort(first.dir);
    const second = startDaemon(firstPort);
    const code = await new Promise<number | null>((r) => second.proc.once('exit', r));
    expect(code).not.toBe(0);
    expect(second.stderr()).toMatch(new RegExp(`Port ${firstPort} \\(config daemon\\.port\\) is in use by another crontick daemon \\(pid \\d+, data dir ${esc(JSON.stringify(first.dir).slice(1, -1))}\\)`));
  });
});
