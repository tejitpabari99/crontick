import * as childProcess from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CrontickError } from '../errors.js';
import { dataDir, ensureDirs, logsDir, pidFilePath, portFilePath } from '../paths.js';

export interface EnsureDaemonOptions {
  daemonUrl?: string;
  daemonScript?: string;
  allowStart?: boolean;
  startupTimeoutMs?: number;
  healthTimeoutMs?: number;
  lockTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface DaemonInfo {
  baseUrl: string;
  port?: number;
  pid?: number;
  started: boolean;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const POLL_MS = 100;
const STDERR_LIMIT = 4096;

export async function resolveDaemonBaseUrl(options: { daemonUrl?: string } = {}): Promise<string> {
  const envUrl = process.env['CRONTICK_DAEMON_URL'];
  const explicit = options.daemonUrl ?? envUrl;
  if (explicit) return normalizeBaseUrl(explicit);

  const port = readPortFile();
  if (port === undefined) {
    throw new CrontickError('DAEMON_NOT_RUNNING', 'Daemon is not running');
  }
  return `http://127.0.0.1:${port}`;
}

export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<DaemonInfo> {
  const env = options.env ?? process.env;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const allowStart = options.allowStart ?? true;

  const explicitUrl = options.daemonUrl ?? env['CRONTICK_DAEMON_URL'];
  if (explicitUrl) {
    const baseUrl = normalizeBaseUrl(explicitUrl);
    const healthy = await probeHealth(baseUrl, healthTimeoutMs);
    if (healthy.ok) return { ...healthy.info, baseUrl, started: false };
    throw new CrontickError('DAEMON_NOT_RUNNING', `Daemon is not reachable at ${baseUrl}`);
  }

  const existing = await probePortFile(healthTimeoutMs);
  if (existing) return { ...existing, started: false };

  if (!allowStart) {
    throw new CrontickError(
      'DAEMON_NOT_RUNNING',
      'Daemon is not running. Start it with: crontick daemon start',
    );
  }

  ensureDirs();
  const lockPath = join(dataDir(), 'daemon.ensure.lock');
  const deadline = Date.now() + startupTimeoutMs;
  let ownsLock = false;

  try {
    while (Date.now() < deadline) {
      const current = await probePortFile(healthTimeoutMs);
      if (current) return { ...current, started: false };

      ownsLock = tryAcquireLock(lockPath);
      if (ownsLock) {
        const rechecked = await probePortFile(healthTimeoutMs);
        if (rechecked) return { ...rechecked, started: false };

        return await startDaemonAndWait({
          daemonScript: resolveDaemonScript(options.daemonScript, env),
          env,
          startupTimeoutMs,
          healthTimeoutMs,
        });
      }

      cleanupStaleLock(lockPath, lockTimeoutMs);
      await sleep(POLL_MS);
    }
  } finally {
    if (ownsLock) releaseLock(lockPath);
  }

  throw new CrontickError(
    'DAEMON_START_LOCK_TIMEOUT',
    'Timed out waiting for another process to start the daemon',
  );
}

async function startDaemonAndWait(args: {
  daemonScript: string;
  env: NodeJS.ProcessEnv;
  startupTimeoutMs: number;
  healthTimeoutMs: number;
}): Promise<DaemonInfo> {
  const { daemonScript, env, startupTimeoutMs, healthTimeoutMs } = args;
  if (!existsSync(daemonScript)) {
    throw new CrontickError(
      'NOT_BUILT',
      `Daemon script not found: ${daemonScript}. Run: npm run build`,
    );
  }

  let childError: Error | undefined;
  let childExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const ensureLogPath = join(logsDir(), 'daemon.ensure.log');
  const logStartOffset = logFileSize(ensureLogPath);
  const stdoutFd = openSync(ensureLogPath, 'a');
  const stderrFd = openSync(ensureLogPath, 'a');

  let child: childProcess.ChildProcess;
  try {
    child = childProcess.spawn(process.execPath, [daemonScript], {
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
      shell: false,
      env,
    });
  } catch (err) {
    closeLogFd(stdoutFd);
    closeLogFd(stderrFd);
    throw new CrontickError('DAEMON_START_FAILED', `Failed to start daemon: ${String(err)}`);
  }
  closeLogFd(stdoutFd);
  closeLogFd(stderrFd);

  child.on('error', (err) => {
    childError = err;
  });
  child.on('exit', (code, signal) => {
    childExit = { code, signal };
  });

  child.unref();

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const healthy = await probePortFile(healthTimeoutMs);
    if (healthy) return { ...healthy, started: true };
    if (childError) {
      const stderr = readEnsureLogTail(ensureLogPath, logStartOffset);
      throw new CrontickError(
        'DAEMON_START_FAILED',
        `Failed to start daemon: ${childError.message}${stderrHint(stderr)}`,
      );
    }
    if (childExit) {
      const stderr = readEnsureLogTail(ensureLogPath, logStartOffset);
      throw new CrontickError(
        'DAEMON_START_FAILED',
        `Daemon exited before becoming healthy (code ${String(childExit.code)}, signal ${String(childExit.signal)})${stderrHint(stderr)}`,
      );
    }
    await sleep(POLL_MS);
  }

  const stderr = readEnsureLogTail(ensureLogPath, logStartOffset);
  throw new CrontickError('DAEMON_TIMEOUT', `Timed out waiting for daemon health${stderrHint(stderr)}`);
}

async function probePortFile(healthTimeoutMs: number): Promise<Omit<DaemonInfo, 'started'> | undefined> {
  const port = readPortFile();
  if (port === undefined) return undefined;
  const baseUrl = `http://127.0.0.1:${port}`;
  const healthy = await probeHealth(baseUrl, healthTimeoutMs);
  if (!healthy.ok) return undefined;
  return { ...healthy.info, baseUrl, port };
}

async function probeHealth(
  baseUrl: string,
  timeoutMs: number,
): Promise<{ ok: true; info: Omit<DaemonInfo, 'baseUrl' | 'started'> } | { ok: false }> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false };
    const data = (await res.json().catch(() => ({}))) as { pid?: unknown; port?: unknown };
    return {
      ok: true,
      info: {
        pid: typeof data.pid === 'number' ? data.pid : readPidFile(),
        port: typeof data.port === 'number' ? data.port : parsePortFromUrl(baseUrl),
      },
    };
  } catch {
    return { ok: false };
  }
}

function resolveDaemonScript(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  if (explicit) return explicit;
  if (env['CRONTICK_DAEMON_BINARY']) return env['CRONTICK_DAEMON_BINARY'];
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, 'index.js');
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function readPortFile(): number | undefined {
  try {
    const port = parseInt(readFileSync(portFilePath(), 'utf-8').trim(), 10);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function readPidFile(): number | undefined {
  try {
    const pid = parseInt(readFileSync(pidFilePath(), 'utf-8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function parsePortFromUrl(baseUrl: string): number | undefined {
  try {
    const port = Number(new URL(baseUrl).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function tryAcquireLock(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf-8');
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function cleanupStaleLock(lockPath: string, lockTimeoutMs: number): void {
  try {
    const raw = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as { pid?: number; createdAt?: number };
    const createdAt = typeof parsed.createdAt === 'number' ? parsed.createdAt : statSync(lockPath).mtimeMs;
    const pid = typeof parsed.pid === 'number' ? parsed.pid : undefined;
    const stale = Date.now() - createdAt > lockTimeoutMs || (pid !== undefined && !pidAlive(pid));
    if (stale) unlinkSync(lockPath);
  } catch {
    try {
      const stale = Date.now() - statSync(lockPath).mtimeMs > lockTimeoutMs;
      if (stale) unlinkSync(lockPath);
    } catch {
      // ignore absent/racing locks
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

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // ignore
  }
}

function logFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function closeLogFd(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // ignore
  }
}

function readEnsureLogTail(path: string, startOffset: number): string {
  try {
    const raw = readFileSync(path);
    const tail = raw.subarray(Math.min(startOffset, raw.length)).toString('utf-8');
    return tail.length > STDERR_LIMIT ? `${tail.slice(0, STDERR_LIMIT)}…` : tail;
  } catch {
    return '';
  }
}

function stderrHint(stderr: string): string {
  return stderr ? `\nDaemon stderr: ${stderr.slice(0, 500)}` : '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
