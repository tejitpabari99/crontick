// poll.mjs — deterministic polling helpers

import { sleep } from './utils.mjs';

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
  const { timeoutSec = 30, intervalMs = 500 } = opts;
  const deadline = Date.now() + timeoutSec * 1000;
  let lastRun = null;

  while (Date.now() < deadline) {
    const r = await cliDriver(['runs', 'list', '--job', jobId, '--json']);
    if (r.exitCode === 0) {
      let runs;
      try { runs = JSON.parse(r.stdout || '[]'); } catch { runs = []; }
      if (Array.isArray(runs) && runs.length > 0 && !['running', 'queued'].includes(runs[0].status)) {
        lastRun = runs[0];
        break;
      }
    }
    if (Date.now() < deadline) await sleep(intervalMs);
  }

  if (!lastRun) {
    throw new Error(`Timed out after ${timeoutSec}s waiting for ${jobId} to reach terminal status`);
  }
  return lastRun;
}
