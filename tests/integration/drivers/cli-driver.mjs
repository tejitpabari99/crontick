// cli-driver.mjs — executes CLI commands via spawned process

import { assertSafeHome, runWithTimeout } from '../utils.mjs';

/** Default CLI timeout in milliseconds. */
const CLI_TIMEOUT_MS = 30_000;

/**
 * Runs a crontick CLI command and returns the result.
 *
 * @param {string[]} args - argv after `crontick` (e.g. ['daemon', 'start', '--json'])
 * @param {{ bins: { crontick: string }; scratchDir: string; testHome: string; env?: Record<string, string> }} ctx
 * @returns {Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>}
 */
export async function runCli(args, ctx) {
  const { bins, scratchDir, testHome, env = {} } = ctx;
  assertSafeHome(testHome, scratchDir);
  return runWithTimeout(
    process.execPath,
    [bins.crontick, ...args],
    {
      cwd: scratchDir,
      env: { ...process.env, CRONTICK_HOME: testHome, ...env },
      shell: false,
    },
    CLI_TIMEOUT_MS,
  );
}
