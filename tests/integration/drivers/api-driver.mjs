// api-driver.mjs — executes library calls via a generated scratch .mjs script

import { runWithTimeout } from '../utils.mjs';

/** Default API timeout in milliseconds. */
const API_TIMEOUT_MS = 30_000;

/**
 * Executes a JavaScript snippet in the installed crontick package context.
 * The snippet has access to `crontick.*` (all public exports).
 *
 * @param {string} scriptBody - JS expression/block; use `crontick.createClient()`, etc.
 * @param {{ scratchDir: string; testHome: string; env?: Record<string, string> }} ctx
 * @returns {Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; parsed: unknown }>}
 */
export async function runApi(scriptBody, ctx) {
  // TODO(A3): implement
  void runWithTimeout;
  void scriptBody;
  void ctx;
  void API_TIMEOUT_MS;
  throw new Error('runApi: not implemented');
}
