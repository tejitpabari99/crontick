// teardown.mjs — cleanup: kill daemon process, remove scratch dirs

/**
 * Kills the daemon for a given test home by reading daemon.pid.
 * SIGTERM first, then SIGKILL after 3s if still alive.
 *
 * @param {string} testHome - Path to the per-test CRONTICK_HOME
 * @returns {Promise<void>}
 */
export async function killDaemonProcess(testHome) {
  // TODO(A3): implement
  void testHome;
  throw new Error('killDaemonProcess: not implemented');
}

/**
 * Runs global teardown after all tests complete.
 *
 * @param {{ scratchDir: string; keepHome?: boolean }} opts
 * @returns {Promise<void>}
 */
export async function runTeardown(opts) {
  // TODO(A3): implement
  void opts;
  throw new Error('runTeardown: not implemented');
}
