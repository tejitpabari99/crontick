// Daemon lifecycle commands: start (foreground/background), stop, restart.
// See docs/concepts/daemon-lifecycle.md
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { CrontickError } from '../errors.js';
import { pidFilePath, portFilePath } from '../paths.js';
import { ensureDaemon, type DaemonInfo, type EnsureDaemonOptions } from './ensure.js';
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

/** Send SIGTERM to the running daemon and poll for exit (up to timeoutMs, default 5 s). */
export async function stopDaemon(options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; logger?: Logger } = {}): Promise<DaemonStopResult> {
  const logger = (options.logger ?? nullLogger).child('stop');
  const env = { ...process.env, ...(options.env ?? {}) };
  const pid = readLiveDaemonPid(env);
  if (pid === undefined) {
    logger.debug('Daemon stop skipped; no live pid', { pidFile: pidFilePath(env) });
    return { ok: true, running: false, stopped: false, message: 'Daemon is not running' };
  }

  try {
    logger.debug('Sending SIGTERM to daemon', { pid });
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    throw new CrontickError(
      'DAEMON_STOP_FAILED',
      `Failed to stop daemon ${pid}: ${err instanceof Error ? err.message : String(err)}. Check whether the process belongs to the current user, then retry: crontick daemon stop`,
      { pid, action: 'crontick daemon stop' },
    );
  }

  const stopped = await waitForStopped(pid, env, options.timeoutMs ?? 5_000);
  logger.debug('Daemon stop completed', { pid, stopped });
  return {
    ok: true,
    running: !stopped,
    pid,
    stopped,
    message: stopped ? `Stopped daemon (pid ${pid})` : `Sent SIGTERM to daemon (pid ${pid})`,
  };
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
