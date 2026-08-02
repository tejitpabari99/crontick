// teardown.mjs — cleanup: kill daemon process, remove scratch dirs

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPidAlive, rmWithRetry, sleepSync } from './utils.mjs';

export { assertSafeHome } from './utils.mjs';

const isWindows = process.platform === 'win32';

/**
 * Kills the daemon for a given test home by reading daemon.pid.
 * SIGTERM first, then SIGKILL after ~3s if still alive.
 * PID-based only; never kills by name.
 *
 * @param {string} testHome - Path to the per-test CRONTICK_HOME
 * @returns {void}
 */
export function killDaemonProcess(testHome) {
  if (!testHome) return;
  const pidFile = join(testHome, 'daemon.pid');
  if (!existsSync(pidFile)) return;

  let pid;
  try {
    pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) return;

  try {
    process.kill(pid, isWindows ? undefined : 'SIGTERM');
  } catch {
    return;
  }

  const gracefulDeadline = Date.now() + 3000;
  while (isPidAlive(pid) && Date.now() < gracefulDeadline) sleepSync(200);

  if (isPidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    const killDeadline = Date.now() + 2000;
    while (isPidAlive(pid) && Date.now() < killDeadline) sleepSync(200);
  }
}

/**
 * Tears down a single test: kill daemon then remove testHome.
 *
 * @param {string} testHome
 * @param {{ keepHome?: boolean }} [opts]
 */
export function teardownTest(testHome, { keepHome = false } = {}) {
  killDaemonProcess(testHome);
  if (!keepHome) rmWithRetry(testHome);
}

/**
 * Global teardown: remove crontick-home dir; keep node_modules/package.json for reuse.
 *
 * @param {{ scratchDir: string }} ctx
 * @param {{ keepHome?: boolean }} [opts]
 */
export function teardownGlobal(ctx, { keepHome = false } = {}) {
  const homeRoot = join(ctx.scratchDir, 'crontick-home');
  if (!keepHome) rmWithRetry(homeRoot);
}
