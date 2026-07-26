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
  /**
   * Major 4: runs that were still `status: 'running'` at the moment the
   * daemon accepted the stop request. Detached children (L8) deliberately
   * survive the daemon's own exit, so these are never canceled here — they
   * are surfaced so the caller can act (wait for them, check back later via
   * `crontick runs list --status running`, or cancel manually) instead of
   * the work silently vanishing from view.
   */
  activeRuns?: Array<{ id: string; jobId: string }>;
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
 *
 * Major 3: a 200 from the route only means the daemon *accepted* the stop
 * request, not that it exited — if the process is still alive after
 * `timeoutMs` (stalled/wedged mid-shutdown), this escalates to SIGTERM and
 * then SIGKILL rather than returning `{ stopped: false, mode: 'graceful' }`
 * with no further recovery.
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
  if (graceful.accepted) {
    const activeRunsNote = formatActiveRunsNote(graceful.activeRuns);
    const stopped = await waitForStopped(pid, env, timeoutMs);
    if (stopped) {
      logger.debug('Graceful daemon stop completed', { pid, stopped });
      return {
        ok: true,
        running: false,
        pid,
        stopped: true,
        mode: 'graceful',
        message: `Stopped daemon (pid ${pid}) via graceful HTTP shutdown${activeRunsNote}`,
        activeRuns: graceful.activeRuns,
      };
    }

    // Major 3: the route accepted the request (200 — `stopping: true`) but
    // the process never actually exited within timeoutMs. Previously this
    // was reported as `{ stopped: false, mode: 'graceful' }` with no further
    // action, leaving a stalled/wedged daemon running forever with no
    // automatic recovery. Escalate the same way the "route unreachable"
    // fallback below already does, rather than only escalating when the
    // HTTP request itself failed.
    logger.debug('Graceful shutdown accepted but daemon did not exit in time; escalating to SIGTERM', { pid, timeoutMs });
    const termStopped = await escalate(pid, 'SIGTERM', env, timeoutMs);
    if (termStopped) {
      return {
        ok: true,
        running: false,
        pid,
        stopped: true,
        mode: 'hard-kill',
        message: `Graceful shutdown of daemon (pid ${pid}) stalled; escalated to SIGTERM${activeRunsNote}`,
        activeRuns: graceful.activeRuns,
      };
    }

    logger.debug('SIGTERM did not stop the stalled daemon in time; escalating to SIGKILL', { pid });
    const killStopped = await escalate(pid, 'SIGKILL', env, timeoutMs);
    return {
      ok: true,
      running: !killStopped,
      pid,
      stopped: killStopped,
      mode: 'hard-kill',
      message: killStopped
        ? `Graceful shutdown of daemon (pid ${pid}) stalled; escalated to SIGKILL${activeRunsNote}`
        : `Daemon (pid ${pid}) did not stop after a graceful request, SIGTERM, and SIGKILL; it may require manual intervention${activeRunsNote}`,
      activeRuns: graceful.activeRuns,
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
  if (stopped) {
    logger.debug('Daemon stop completed', { pid, stopped });
    return {
      ok: true,
      running: false,
      pid,
      stopped: true,
      mode: 'hard-kill',
      message: `Stopped daemon (pid ${pid})`,
    };
  }

  // Major 3: SIGTERM alone didn't stop it either — escalate to SIGKILL rather
  // than reporting an unstopped daemon as merely "sent SIGTERM".
  logger.debug('SIGTERM did not stop daemon in time; escalating to SIGKILL', { pid });
  const killStopped = await escalate(pid, 'SIGKILL', env, timeoutMs);
  logger.debug('Daemon stop completed', { pid, stopped: killStopped });
  return {
    ok: true,
    running: !killStopped,
    pid,
    stopped: killStopped,
    mode: 'hard-kill',
    message: killStopped
      ? `Daemon (pid ${pid}) did not respond to SIGTERM; escalated to SIGKILL`
      : `Sent SIGTERM and SIGKILL to daemon (pid ${pid}), but it did not exit`,
  };
}

/** Send `signal` to `pid` and wait up to `timeoutMs` for it to exit. Treats an already-gone pid as stopped. */
async function escalate(pid: number, signal: NodeJS.Signals, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<boolean> {
  try {
    process.kill(pid, signal);
  } catch {
    return true; // process already gone
  }
  return waitForStopped(pid, env, timeoutMs);
}

/** Human-readable suffix noting runs left in progress (Major 4) — empty string when none. */
function formatActiveRunsNote(activeRuns?: Array<{ id: string; jobId: string }>): string {
  if (!activeRuns || activeRuns.length === 0) return '';
  return ` (${activeRuns.length} run(s) still in progress will keep running after the daemon exits: ${activeRuns.map((r) => r.id).join(', ')})`;
}

/** POST /api/daemon/stop and return whether the daemon accepted (200) the request, plus any runs it reported as still in progress. */
async function tryGracefulHttpStop(env: NodeJS.ProcessEnv, logger: Logger): Promise<{ accepted: boolean; activeRuns?: Array<{ id: string; jobId: string }> }> {
  try {
    const baseUrl = await resolveDaemonBaseUrl({ env, logger });
    const res = await fetch(`${baseUrl}/api/daemon/stop`, {
      method: 'POST',
      signal: AbortSignal.timeout(HTTP_STOP_TIMEOUT_MS),
    });
    if (!res.ok) return { accepted: false };
    let activeRuns: Array<{ id: string; jobId: string }> | undefined;
    try {
      const body = (await res.json()) as { activeRuns?: Array<{ id: string; jobId: string }> };
      if (Array.isArray(body?.activeRuns) && body.activeRuns.length > 0) activeRuns = body.activeRuns;
    } catch {
      // Body didn't parse as JSON with the expected shape — treat as "no
      // active-run info available", not as a failed stop request.
    }
    return { accepted: true, activeRuns };
  } catch (err) {
    logger.debug('Graceful HTTP stop request failed', { error: err instanceof Error ? err.message : String(err) });
    return { accepted: false };
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
