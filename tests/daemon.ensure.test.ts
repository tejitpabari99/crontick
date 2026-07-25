import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ensureDaemon, resolveDaemonBaseUrl } from '../src/daemon/ensure.js';
import { CrontickError } from '../src/errors.js';

const scratchRoot = resolve('.crontick', 'ensure-tests');
let previousHome: string | undefined;
let previousUrl: string | undefined;
let currentHome: string | undefined;
const cleanupFns: Array<() => void | Promise<void>> = [];

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
    res.end(JSON.stringify({ ok: true, product: 'crontick', pid: process.pid, port: serverPort }));
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
  res.end(JSON.stringify({ ok: true, product: 'crontick', pid: process.pid, port }));
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  const stderrChunks: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));
  return new Promise((resolveExit, rejectExit) => {
    child.on('error', rejectExit);
    child.on('exit', (code, signal) => resolveExit({ code, signal, stderr: stderrChunks.join('') }));
  });
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

  it('rejects a foreign health payload on a reused port', async () => {
    const home = makeHome();
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
    });
    await new Promise<void>((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
    cleanupFns.push(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    writeFileSync(join(home, 'daemon.port'), String(port), 'utf-8');

    await expectRejectCode(
      ensureDaemon({ allowStart: false, daemonScript: join(home, 'missing.mjs') }),
      'DAEMON_NOT_RUNNING',
    );
  });

  it('starts a missing daemon and waits for health', async () => {
    const home = makeHome();
    const script = writeFakeDaemon(home);

    const info = await ensureDaemon({ daemonScript: script, startupTimeoutMs: 5_000 });

    expect(info.started).toBe(true);
    expect(info.port).toBeGreaterThan(0);
    expect(existsSync(join(home, 'daemon.port'))).toBe(true);
  });

  it('starts daemon stdio through a durable log file after launcher exit', async () => {
    const home = makeHome();
    const script = writeFakeDaemon(
      home,
      'stderr-daemon.mjs',
      [
        "import http from 'node:http';",
        "import { appendFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const home = process.env.CRONTICK_HOME;',
        "mkdirSync(join(home, 'logs'), { recursive: true });",
        "const server = http.createServer((_req, res) => {",
        "  res.writeHead(200, { 'Content-Type': 'application/json' });",
        '  const port = server.address() && typeof server.address() === "object" ? server.address().port : undefined;',
        "  res.end(JSON.stringify({ ok: true, product: 'crontick', pid: process.pid, port }));",
        '});',
        'function cleanup() {',
        "  try { unlinkSync(join(home, 'daemon.port')); } catch {}",
        "  try { unlinkSync(join(home, 'daemon.pid')); } catch {}",
        '}',
        "process.on('uncaughtException', (err) => {",
        "  appendFileSync(join(home, 'uncaught.txt'), `${err && err.code ? err.code : String(err)}\\n`);",
        '  cleanup();',
        '  process.exit(1);',
        '});',
        "server.listen(0, '127.0.0.1', () => {",
        '  const port = server.address() && typeof server.address() === "object" ? server.address().port : 0;',
        "  writeFileSync(join(home, 'daemon.pid'), String(process.pid), 'utf-8');",
        "  writeFileSync(join(home, 'daemon.port'), String(port), 'utf-8');",
        "  process.stderr.write('daemon ready on stderr\\n');",
        '});',
        'let tick = 0;',
        'const interval = setInterval(() => {',
        '  tick += 1;',
        "  process.stderr.write(`daemon tick ${tick}\\n`);",
        "  appendFileSync(join(home, 'ticks.txt'), `${tick}\\n`);",
        '}, 50);',
        "process.on('SIGTERM', () => { clearInterval(interval); cleanup(); server.close(() => process.exit(0)); });",
        "process.on('SIGINT', () => { clearInterval(interval); cleanup(); server.close(() => process.exit(0)); });",
      ].join('\n'),
    );
    const launcher = join(home, 'launcher.mjs');
    const ensureUrl = pathToFileURL(join(process.cwd(), 'dist', 'index.js')).href;
    writeFileSync(
      launcher,
      [
        `import { ensureDaemon } from ${JSON.stringify(ensureUrl)};`,
        `await ensureDaemon({ daemonScript: ${JSON.stringify(script)}, startupTimeoutMs: 5000 });`,
      ].join('\n'),
      'utf-8',
    );

    const launcherProc = spawn(process.execPath, [launcher], {
      env: { ...process.env, CRONTICK_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const launcherExit = await waitForExit(launcherProc);

    expect(launcherExit).toMatchObject({ code: 0, signal: null });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    expect(existsSync(join(home, 'uncaught.txt'))).toBe(false);
    const port = Number(readFileSync(join(home, 'daemon.port'), 'utf-8'));
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((res) => res.ok).catch(() => false);
    expect(health).toBe(true);
    expect(readFileSync(join(home, 'logs', 'daemon.ensure.log'), 'utf-8')).toContain('daemon tick');
  }, 10_000);

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

  it('cleans up a hung start that writes pid and port but never becomes healthy', async () => {
    const home = makeHome();
    const hung = writeFakeDaemon(
      home,
      'hung-daemon.mjs',
      [
        "import http from 'node:http';",
        "import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const home = process.env.CRONTICK_HOME;',
        "mkdirSync(join(home, 'logs'), { recursive: true });",
        "writeFileSync(join(home, 'daemon.pid'), String(process.pid), 'utf-8');",
        "writeFileSync(join(home, 'spawned-pid.txt'), String(process.pid), 'utf-8');",
        'const server = http.createServer((_req, res) => {',
        "  res.writeHead(200, { 'Content-Type': 'application/json' });",
        '  const port = server.address() && typeof server.address() === "object" ? server.address().port : 0;',
        '  res.end(JSON.stringify({ ok: true, pid: process.pid, port }));',
        '});',
        "server.listen(0, '127.0.0.1', () => {",
        '  const port = server.address() && typeof server.address() === "object" ? server.address().port : 0;',
        "  writeFileSync(join(home, 'daemon.port'), String(port), 'utf-8');",
        '});',
        'function cleanup() {',
        "  try { unlinkSync(join(home, 'daemon.port')); } catch {}",
        "  try { unlinkSync(join(home, 'daemon.pid')); } catch {}",
        '}',
        "process.on('SIGTERM', () => { cleanup(); server.close(() => process.exit(0)); });",
        "process.on('SIGINT', () => { cleanup(); server.close(() => process.exit(0)); });",
      ].join('\n'),
    );

    await expectRejectCode(
      ensureDaemon({ daemonScript: hung, startupTimeoutMs: 800, healthTimeoutMs: 50 }),
      'DAEMON_TIMEOUT',
    );

    const spawnedPid = Number(readFileSync(join(home, 'spawned-pid.txt'), 'utf-8'));
    expect(pidAlive(spawnedPid)).toBe(false);
    expect(existsSync(join(home, 'daemon.port'))).toBe(false);
    expect(existsSync(join(home, 'daemon.pid'))).toBe(false);

    const good = writeFakeDaemon(home, 'good-daemon.mjs');
    const info = await ensureDaemon({ daemonScript: good, startupTimeoutMs: 5_000 });
    expect(info.started).toBe(true);
  }, 10_000);

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

  it('uses the same CRONTICK_HOME from options.env for locks, polling, and the child daemon', async () => {
    const processHome = makeHome();
    const envHome = join(scratchRoot, randomUUID());
    mkdirSync(envHome, { recursive: true });
    cleanupFns.push(() => {
      killHomeDaemon(envHome);
      rmSync(envHome, { recursive: true, force: true });
    });
    const script = writeFakeDaemon(envHome);
    const env = { ...process.env, CRONTICK_HOME: envHome };

    const info = await ensureDaemon({ daemonScript: script, env, startupTimeoutMs: 5_000 });

    expect(info.started).toBe(true);
    expect(existsSync(join(envHome, 'daemon.port'))).toBe(true);
    expect(existsSync(join(processHome, 'daemon.port'))).toBe(false);
    expect(existsSync(join(processHome, 'daemon.ensure.lock'))).toBe(false);
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

  it('keeps an unparseable recent start lock instead of deleting a live owner window', async () => {
    const home = makeHome();
    const lockPath = join(home, 'daemon.ensure.lock');
    writeFileSync(lockPath, '', 'utf-8');
    setTimeout(() => {
      void startHealthServer(home);
    }, 500);

    const info = await ensureDaemon({
      daemonScript: join(home, 'missing.mjs'),
      startupTimeoutMs: 2_000,
      lockTimeoutMs: 5_000,
    });

    expect(info.started).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
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
