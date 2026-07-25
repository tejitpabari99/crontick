import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDaemon, resolveDaemonBaseUrl } from '../src/daemon/ensure.js';
import { CrontickError } from '../src/errors.js';

const scratchRoot = resolve('.crontick', 'ensure-tests');
let previousHome: string | undefined;
let previousUrl: string | undefined;
let currentHome: string | undefined;
let cleanupFns: Array<() => void | Promise<void>> = [];

function makeHome(): string {
  mkdirSync(scratchRoot, { recursive: true });
  const home = join(scratchRoot, randomUUID());
  mkdirSync(join(home, 'logs'), { recursive: true });
  mkdirSync(join(home, 'jobs'), { recursive: true });
  previousHome = process.env['CRONTICK_HOME'];
  previousUrl = process.env['CRONTICK_DAEMON_URL'];
  process.env['CRONTICK_HOME'] = home;
  delete process.env['CRONTICK_DAEMON_URL'];
  currentHome = home;
  return home;
}

async function startHealthServer(home?: string): Promise<{ baseUrl: string; port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    const addr = server.address();
    const serverPort = typeof addr === 'object' && addr ? addr.port : undefined;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: process.pid, port: serverPort }));
  });
  await new Promise<void>((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  if (home) writeFileSync(join(home, 'daemon.port'), String(port), 'utf-8');
  const close = () => new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  cleanupFns.push(close);
  return { baseUrl: `http://127.0.0.1:${port}`, port, close };
}

function writeFakeDaemon(home: string, name = 'fake-daemon.mjs', body?: string): string {
  const script = join(home, name);
  const content = body ?? `
import http from 'node:http';
import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.CRONTICK_HOME;
mkdirSync(join(home, 'logs'), { recursive: true });
appendFileSync(join(home, 'start-count.txt'), '1\\n');
const delay = Number(process.env.FAKE_DAEMON_DELAY_MS ?? '0');
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  const port = server.address() && typeof server.address() === 'object' ? server.address().port : undefined;
  res.end(JSON.stringify({ ok: true, pid: process.pid, port }));
});
function cleanup() {
  try { unlinkSync(join(home, 'daemon.port')); } catch {}
  try { unlinkSync(join(home, 'daemon.pid')); } catch {}
}
setTimeout(() => {
  server.listen(0, '127.0.0.1', () => {
    const port = server.address() && typeof server.address() === 'object' ? server.address().port : 0;
    writeFileSync(join(home, 'daemon.pid'), String(process.pid), 'utf-8');
    writeFileSync(join(home, 'daemon.port'), String(port), 'utf-8');
  });
}, delay);
process.on('SIGTERM', () => { cleanup(); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { cleanup(); server.close(() => process.exit(0)); });
`;
  writeFileSync(script, content, 'utf-8');
  return script;
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

async function expectRejectCode(promise: Promise<unknown>, code: string): Promise<CrontickError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CrontickError);
    expect((err as CrontickError).code).toBe(code);
    return err as CrontickError;
  }
  throw new Error(`Expected rejection with ${code}`);
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
  vi.restoreAllMocks();
});

describe('ensureDaemon', () => {
  it('reuses a healthy daemon from the port file', async () => {
    const home = makeHome();
    const server = await startHealthServer(home);

    await expect(resolveDaemonBaseUrl()).resolves.toBe(server.baseUrl);
    const info = await ensureDaemon({ daemonScript: join(home, 'missing.mjs') });

    expect(info).toMatchObject({ baseUrl: server.baseUrl, port: server.port, started: false });
    expect(existsSync(join(home, 'daemon.ensure.lock'))).toBe(false);
  });

  it('uses CRONTICK_DAEMON_URL before the port file', async () => {
    makeHome();
    const server = await startHealthServer();
    process.env['CRONTICK_DAEMON_URL'] = `${server.baseUrl}/`;

    const info = await ensureDaemon();

    expect(info.baseUrl).toBe(server.baseUrl);
    expect(info.started).toBe(false);
  });

  it('starts a missing daemon and waits for health', async () => {
    const home = makeHome();
    const script = writeFakeDaemon(home);

    const info = await ensureDaemon({ daemonScript: script, startupTimeoutMs: 5_000 });

    expect(info.started).toBe(true);
    expect(info.port).toBeGreaterThan(0);
    expect(existsSync(join(home, 'daemon.port'))).toBe(true);
  });

  it('fails clearly when the daemon script is missing', async () => {
    const home = makeHome();

    const err = await expectRejectCode(
      ensureDaemon({ daemonScript: join(home, 'missing.mjs'), startupTimeoutMs: 500 }),
      'NOT_BUILT',
    );

    expect(err.message).toContain('Daemon script not found');
    expect(err.message).toContain('npm run build');
  });

  it('captures early child failures in the ensure log', async () => {
    const home = makeHome();
    const script = writeFakeDaemon(home, 'bad-daemon.mjs', "console.error('boom'); process.exit(7);");

    await expectRejectCode(
      ensureDaemon({ daemonScript: script, startupTimeoutMs: 2_000 }),
      'DAEMON_START_FAILED',
    );

    expect(readFileSync(join(home, 'logs', 'daemon.ensure.log'), 'utf-8')).toContain('boom');
  });

  it('does not start when allowStart is false', async () => {
    const home = makeHome();

    await expectRejectCode(
      ensureDaemon({ allowStart: false, daemonScript: join(home, 'missing.mjs') }),
      'DAEMON_NOT_RUNNING',
    );

    expect(existsSync(join(home, 'daemon.ensure.lock'))).toBe(false);
  });

  it('starts only once for concurrent callers', async () => {
    const home = makeHome();
    const script = writeFakeDaemon(home);
    const env = { ...process.env, CRONTICK_HOME: home, FAKE_DAEMON_DELAY_MS: '400' };

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ensureDaemon({ daemonScript: script, env, startupTimeoutMs: 5_000, lockTimeoutMs: 5_000 }),
      ),
    );

    expect(results.every((r) => r.baseUrl === results[0].baseUrl)).toBe(true);
    expect(readFileSync(join(home, 'start-count.txt'), 'utf-8').trim().split(/\r?\n/)).toHaveLength(1);
    expect(existsSync(join(home, 'daemon.ensure.lock'))).toBe(false);
  });

  it('waits when another process owns the start lock and health appears', async () => {
    const home = makeHome();
    writeFileSync(join(home, 'daemon.ensure.lock'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    setTimeout(() => {
      void startHealthServer(home);
    }, 200);

    const info = await ensureDaemon({
      daemonScript: join(home, 'missing.mjs'),
      startupTimeoutMs: 2_000,
      lockTimeoutMs: 5_000,
    });

    expect(info.started).toBe(false);
  });

  it('removes a stale lock before starting', async () => {
    const home = makeHome();
    const script = writeFakeDaemon(home);
    writeFileSync(join(home, 'daemon.ensure.lock'), JSON.stringify({ pid: 999999, createdAt: 0 }));

    const info = await ensureDaemon({ daemonScript: script, startupTimeoutMs: 5_000, lockTimeoutMs: 50 });

    expect(info.started).toBe(true);
    expect(existsSync(join(home, 'daemon.ensure.lock'))).toBe(false);
  });
});
