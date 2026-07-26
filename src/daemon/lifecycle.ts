// Daemon lifecycle commands: start (foreground/background), stop, restart.
// See docs/concepts/daemon-lifecycle.md
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { CrontickError } from '../errors.js';
import { pidFilePath, portFilePath } from '../paths.js';
import { ensureDaemon, resolveDaemonBaseUrl, type DaemonInfo, type EnsureDaemonOptions } from './ensure.js';
import { nullLogger, type Logger } from '../logger.js';

export interface DaemonLifecycleOptions extends EnsureDaemonOptions {
  foreground?: boolean;
}

export interface DaemonStartResult extends DaemonInfo {
  ok: true;
  foregroundExitCode?: number | null;
}

export interface DaemonStopResult {
  ok: true;
  running: boolean;
  pid?: number;
  stopped: boolean;
  message: string;
  /** L1: how the daemon was asked to stop (or that it was already stopped). */
  mode: 'already-stopped' | 'graceful' | 'hard-kill';
}

export interface DaemonRestartResult extends DaemonInfo {
  ok: true;
  stopped: boolean;
  previousPid?: number;
}

/** Start the daemon. Foreground mode uses spawnSync (blocks); background delegates to ensureDaemon. */
export async function startDaemon(options: DaemonLifecycleOptions = {}): Promise<DaemonStartResult> {
  const logger = (options.logger ?? nullLogger).child('start');
  if (options.foreground) {
    const script = options.daemonScript;
    if (!script || !existsSync(script)) {
      throw new CrontickError(
        'NOT_BUILT',
        `Daemon script not found: ${script ?? '<default>'}. Attempted foreground daemon start. Run: npm run build`,
        { daemonScript: script, action: 'npm run build' },
      );
    }
    logger.debug('Starting daemon in foreground', { daemonScript: script });
    const result = spawnSync(process.execPath, [script], {
      stdio: 'inherit',
      env: { ...process.env, ...(options.env ?? {}) },
    });
    return { ok: true, baseUrl: '', started: true, foregroundExitCode: result.status };
  }

  logger.debug('Ensuring background daemon');
  const info = await ensureDaemon({ ...options, startDaemon: true });
  return { ok: true, ...info };
}

/** How long to wait for the initial HTTP response from POST /api/daemon/stop before falling back to SIGTERM. */
const HTTP_STOP_TIMEOUT_MS = 2_000;

/**
 * Stop the running daemon (L1). Prefers a graceful, in-process HTTP shutdown
 * (POST /api/daemon/stop — see api.ts) over signals: signals are the only
 * option on POSIX but are unreliable to depend on for cleanup ordering, and
 * Windows has no SIGTERM equivalent at all (Node maps it to an abrupt
 * TerminateProcess-style kill there), so the daemon's own graceful shutdown
 * path is the one mechanism that works identically on every platform. Falls
 * back to a SIGTERM/hard-kill if the HTTP route can't be reached (older
 * daemon build, port file stale/missing, connection refused) so `crontick
 * daemon stop` still works against a wedged or already-broken daemon.
 */
export async function stopDaemon(options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; logger?: Logger } = {}): Promise<DaemonStopResult> {
  const logger = (options.logger ?? nullLogger).child('stop');
  const env = { ...process.env, ...(options.env ?? {}) };
  const pid = readLiveDaemonPid(env);
  if (pid === undefined) {
    logger.debug('Daemon stop skipped; no live pid', { pidFile: pidFilePath(env) });
    return { ok: true, running: false, stopped: false, message: 'Daemon is not running', mode: 'already-stopped' };
  }

  const timeoutMs = options.timeoutMs ?? 5_000;
  const graceful = await tryGracefulHttpStop(env, logger);
  if (graceful) {
    const stopped = await waitForStopped(pid, env, timeoutMs);
    logger.debug('Graceful daemon stop completed', { pid, stopped });
    return {
      ok: true,
      running: !stopped,
      pid,
      stopped,
      mode: 'graceful',
      message: stopped ? `Stopped daemon (pid ${pid}) via graceful HTTP shutdown` : `Requested graceful shutdown of daemon (pid ${pid})`,
    };
  }

  logger.debug('Graceful HTTP stop unavailable; falling back to SIGTERM', { pid });
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    throw new CrontickError(
      'DAEMON_STOP_FAILED',
      `Failed to stop daemon ${pid}: ${err instanceof Error ? err.message : String(err)}. Check whether the process belongs to the current user, then retry: crontick daemon stop`,
      { pid, action: 'crontick daemon stop' },
    );
  }

  const stopped = await waitForStopped(pid, env, timeoutMs);
  logger.debug('Daemon stop completed', { pid, stopped });
  return {
    ok: true,
    running: !stopped,
    pid,
    stopped,
    mode: 'hard-kill',
    message: stopped ? `Stopped daemon (pid ${pid})` : `Sent SIGTERM to daemon (pid ${pid})`,
  };
}

/** POST /api/daemon/stop and return true only once the daemon has accepted (200) the request. */
async function tryGracefulHttpStop(env: NodeJS.ProcessEnv, logger: Logger): Promise<boolean> {
  try {
    const baseUrl = await resolveDaemonBaseUrl({ env, logger });
    const res = await fetch(`${baseUrl}/api/daemon/stop`, {
      method: 'POST',
      signal: AbortSignal.timeout(HTTP_STOP_TIMEOUT_MS),
    });
    return res.ok;
  } catch (err) {
    logger.debug('Graceful HTTP stop request failed', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export async function restartDaemon(options: EnsureDaemonOptions = {}): Promise<DaemonRestartResult> {
  const stopped = await stopDaemon({ env: options.env, logger: options.logger });
  const info = await ensureDaemon({ ...options, startDaemon: true });
  return { ok: true, ...info, stopped: stopped.stopped, previousPid: stopped.pid };
}

/** Read the PID file and verify the process is alive. Returns undefined if stale or absent. */
export function readLiveDaemonPid(env: NodeJS.ProcessEnv = process.env): number | undefined {
  if (!existsSync(pidFilePath(env))) return undefined;
  const pid = Number.parseInt(readFileSync(pidFilePath(env), 'utf-8').trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

async function waitForStopped(pid: number, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = isPidAlive(pid);
    const portExists = existsSync(portFilePath(env));
    if (!alive && !portExists) return true;
    if (!alive) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
