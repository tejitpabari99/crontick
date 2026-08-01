// poll.mjs — deterministic polling helpers

/**
 * Polls `crontick runs list --job <jobId>` until the most recent run reaches a
 * terminal status (not 'running' or 'queued') or the timeout elapses.
 *
 * @param {(args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>} cliDriver
 * @param {string} jobId
 * @param {{ timeoutSec?: number; intervalMs?: number }} [opts]
 * @returns {Promise<object>} The terminal run record
 */
export async function pollUntilTerminal(cliDriver, jobId, opts = {}) {
  // TODO(A4): implement
  void cliDriver;
  void jobId;
  void opts;
  throw new Error('pollUntilTerminal: not implemented');
}
