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
import { nullLogger, type Logger } from '../logger.js';

export interface EnsureDaemonOptions {
  daemonUrl?: string;
  daemonScript?: string;
  startDaemon?: boolean;
  startupTimeoutMs?: number;
  healthTimeoutMs?: number;
  lockTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
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
const HEALTH_PRODUCT = 'crontick';

export async function resolveDaemonBaseUrl(options: { daemonUrl?: string; env?: NodeJS.ProcessEnv; logger?: Logger } = {}): Promise<string> {
  const logger = (options.logger ?? nullLogger).child('resolve');
  const env = { ...process.env, ...(options.env ?? {}) };
  const envUrl = env['CRONTICK_DAEMON_URL'];
  const explicit = options.daemonUrl ?? envUrl;
  if (explicit) {
    const baseUrl = normalizeBaseUrl(explicit);
    logger.debug('Using explicit daemon URL', { source: options.daemonUrl ? 'option' : 'CRONTICK_DAEMON_URL', baseUrl });
    return baseUrl;
  }

  const port = readPortFile(env);
  if (port === undefined) {
    logger.debug('No daemon port file found', { portFile: portFilePath(env) });
    throw new CrontickError('DAEMON_NOT_RUNNING', 'Daemon is not running');
  }
  logger.debug('Resolved daemon URL from port file', { portFile: portFilePath(env), port });
  return `http://127.0.0.1:${port}`;
}

export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<DaemonInfo> {
  const logger = (options.logger ?? nullLogger).child('ensure');
  const env = { ...process.env, ...(options.env ?? {}) };
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const shouldStartDaemon = options.startDaemon ?? true;

  const explicitUrl = options.daemonUrl ?? env['CRONTICK_DAEMON_URL'];
  if (explicitUrl) {
    const baseUrl = normalizeBaseUrl(explicitUrl);
    logger.debug('Probing explicit daemon URL', { baseUrl, healthTimeoutMs });
    const healthy = await probeHealth(baseUrl, healthTimeoutMs);
    if (healthy.ok) {
      logger.debug('Explicit daemon URL is healthy', { baseUrl, pid: healthy.info.pid, port: healthy.info.port });
      return { ...healthy.info, baseUrl, started: false };
    }
    throw new CrontickError(
      'DAEMON_NOT_RUNNING',
      `Daemon is not reachable at ${baseUrl}. Attempted a health check against CRONTICK_DAEMON_URL/daemonUrl and did not receive a valid crontick health response. Check that the URL is correct, or run: crontick daemon status`,
      { baseUrl, action: 'crontick daemon status' },
    );
  }

  logger.debug('Probing daemon port file', { portFile: portFilePath(env), healthTimeoutMs });
  const existing = await probePortFile(env, healthTimeoutMs);
  if (existing) {
    logger.debug('Existing daemon is healthy', { baseUrl: existing.baseUrl, pid: existing.pid, port: existing.port });
    return { ...existing, started: false };
  }

  if (!shouldStartDaemon) {
    throw new CrontickError(
      'DAEMON_NOT_RUNNING',
      `Daemon is not running. Attempted to resolve ${portFilePath(env)} but no healthy daemon was found, and startDaemon is false. Start it with: crontick daemon start`,
      { portFile: portFilePath(env), action: 'crontick daemon start' },
    );
  }

  ensureDirs(env);
  const lockPath = join(dataDir(env), 'daemon.ensure.lock');
  const deadline = Date.now() + startupTimeoutMs;
  let ownsLock = false;

  try {
    while (Date.now() < deadline) {
      const current = await probePortFile(env, healthTimeoutMs);
      if (current) return { ...current, started: false };

      ownsLock = tryAcquireLock(lockPath);
      if (ownsLock) {
        logger.debug('Acquired daemon start lock', { lockPath });
        const rechecked = await probePortFile(env, healthTimeoutMs);
        if (rechecked) {
          logger.debug('Daemon became healthy after lock acquisition', { baseUrl: rechecked.baseUrl });
          return { ...rechecked, started: false };
        }

        return await startDaemonAndWait({
          daemonScript: resolveDaemonScript(options.daemonScript, env),
          env,
          startupTimeoutMs,
          healthTimeoutMs,
          logger,
        });
      }

      logger.debug('Waiting for daemon start lock', { lockPath });
      cleanupStaleLock(lockPath, lockTimeoutMs);
      await sleep(POLL_MS);
    }
  } finally {
    if (ownsLock) releaseLock(lockPath);
  }

  throw new CrontickError(
    'DAEMON_START_LOCK_TIMEOUT',
    `Timed out waiting for another process to start the daemon. Attempted to acquire ${lockPath} for ${startupTimeoutMs}ms. Remove the stale lock if no crontick start is running, then retry: crontick daemon start`,
    { lockPath, action: 'crontick daemon start' },
  );
}

async function startDaemonAndWait(args: {
  daemonScript: string;
  env: NodeJS.ProcessEnv;
  startupTimeoutMs: number;
  healthTimeoutMs: number;
  logger: Logger;
}): Promise<DaemonInfo> {
  const { daemonScript, env, startupTimeoutMs, healthTimeoutMs, logger } = args;
  if (!existsSync(daemonScript)) {
    throw new CrontickError(
      'NOT_BUILT',
      `Daemon script not found: ${daemonScript}. Attempted to start the daemon with Node at ${process.execPath}. Run: npm run build`,
      { daemonScript, action: 'npm run build' },
    );
  }

  let childError: Error | undefined;
  let childExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const ensureLogPath = join(logsDir(env), 'daemon.ensure.log');
  logger.debug('Starting daemon process', { daemonScript, ensureLogPath, startupTimeoutMs });
  const logStartOffset = logFileSize(ensureLogPath);
  const startedPidPath = pidFilePath(env);
  const startedPortPath = portFilePath(env);
  const initialPidFile = readOptionalFile(startedPidPath);
  const initialPortFile = readOptionalFile(startedPortPath);
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
    throw new CrontickError(
      'DAEMON_START_FAILED',
      `Failed to start daemon with ${process.execPath} ${daemonScript}: ${errorMessage(err)}. Inspect ${ensureLogPath} and retry: crontick daemon start`,
      { daemonScript, logPath: ensureLogPath, action: 'crontick daemon start' },
    );
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

  try {
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      const healthy = await probePortFile(env, healthTimeoutMs);
      if (healthy) {
        logger.debug('Started daemon became healthy', { baseUrl: healthy.baseUrl, pid: healthy.pid, port: healthy.port, ensureLogPath });
        return { ...healthy, started: true };
      }
      if (childError) {
        const stderr = readEnsureLogTail(ensureLogPath, logStartOffset);
        throw new CrontickError(
          'DAEMON_START_FAILED',
          `Failed to start daemon with ${process.execPath} ${daemonScript}: ${childError.message}${stderrHint(stderr, ensureLogPath)}. Retry with: crontick daemon start`,
          { daemonScript, logPath: ensureLogPath, action: 'crontick daemon start' },
        );
      }
      if (childExit) {
        const stderr = readEnsureLogTail(ensureLogPath, logStartOffset);
        throw new CrontickError(
          'DAEMON_START_FAILED',
          `Daemon exited before becoming healthy after ${process.execPath} ${daemonScript} (code ${String(childExit.code)}, signal ${String(childExit.signal)})${stderrHint(stderr, ensureLogPath)}. Inspect ${ensureLogPath}, then run: crontick daemon start`,
          { daemonScript, logPath: ensureLogPath, exitCode: childExit.code, signal: childExit.signal, action: 'crontick daemon start' },
        );
      }
      logger.debug('Waiting for daemon health', { daemonScript, ensureLogPath });
      await sleep(POLL_MS);
    }

    const stderr = readEnsureLogTail(ensureLogPath, logStartOffset);
    throw new CrontickError(
      'DAEMON_TIMEOUT',
      `Timed out after ${startupTimeoutMs}ms waiting for daemon health after starting ${daemonScript}${stderrHint(stderr, ensureLogPath)}. Inspect ${ensureLogPath}, check permissions under ${dataDir(env)}, then retry: crontick daemon start`,
      { daemonScript, logPath: ensureLogPath, action: 'crontick daemon start' },
    );
  } catch (err) {
    await terminateStartedProcess(child, () => childExit !== undefined);
    cleanupStartedFiles({
      childPid: child.pid,
      pidPath: startedPidPath,
      portPath: startedPortPath,
      initialPidFile,
      initialPortFile,
    });
    throw err;
  }
}

async function probePortFile(
  env: NodeJS.ProcessEnv,
  healthTimeoutMs: number,
): Promise<Omit<DaemonInfo, 'started'> | undefined> {
  const port = readPortFile(env);
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
    const data = (await res.json().catch(() => ({}))) as {
      ok?: unknown;
      product?: unknown;
      name?: unknown;
      pid?: unknown;
      port?: unknown;
    };
    const product = data.product ?? data.name;
    if (
      data.ok !== true
      || product !== HEALTH_PRODUCT
      || typeof data.pid !== 'number'
      || !Number.isInteger(data.pid)
      || data.pid <= 0
      || typeof data.port !== 'number'
      || !Number.isInteger(data.port)
      || data.port <= 0
    ) {
      return { ok: false };
    }
    const expectedPort = Number(new URL(baseUrl).port);
    if (Number.isInteger(expectedPort) && expectedPort > 0 && data.port !== expectedPort) {
      return { ok: false };
    }
    return {
      ok: true,
      info: {
        pid: data.pid,
        port: data.port,
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

function readPortFile(env: NodeJS.ProcessEnv = process.env): number | undefined {
  try {
    const port = parseInt(readFileSync(portFilePath(env), 'utf-8').trim(), 10);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function readOptionalFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

async function terminateStartedProcess(
  child: childProcess.ChildProcess,
  hasExited: () => boolean,
): Promise<void> {
  if (hasExited()) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore termination races
  }
  const exited = await waitForChildExit(hasExited, 2_000);
  if (exited) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // ignore termination races
  }
  await waitForChildExit(hasExited, 1_000);
}

function cleanupStartedFiles(args: {
  childPid?: number;
  pidPath: string;
  portPath: string;
  initialPidFile?: string;
  initialPortFile?: string;
}): void {
  const currentPidFile = readOptionalFile(args.pidPath);
  const pidBelongsToChild =
    args.childPid !== undefined && currentPidFile?.trim() === String(args.childPid);
  if (pidBelongsToChild || (args.initialPidFile === undefined && currentPidFile !== undefined)) {
    try {
      unlinkSync(args.pidPath);
    } catch {
      // ignore cleanup races
    }
  }

  const currentPortFile = readOptionalFile(args.portPath);
  if (
    pidBelongsToChild
    || (args.initialPortFile === undefined && currentPortFile !== undefined)
  ) {
    try {
      unlinkSync(args.portPath);
    } catch {
      // ignore cleanup races
    }
  }
}

async function waitForChildExit(hasExited: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasExited()) return true;
    await sleep(50);
  }
  return hasExited();
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

function stderrHint(stderr: string, logPath: string): string {
  return stderr ? `\nDaemon stderr excerpt from ${logPath}: ${stderr.slice(0, 500)}` : `\nDaemon log path: ${logPath}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
