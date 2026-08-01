// cli-driver.mjs — executes CLI commands via spawned process

import { runWithTimeout } from '../utils.mjs';

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
  // TODO(A3): implement
  void runWithTimeout;
  void args;
  void ctx;
  void CLI_TIMEOUT_MS;
  throw new Error('runCli: not implemented');
}
