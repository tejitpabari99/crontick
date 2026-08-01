// utils.mjs — shared harness utilities
// TODO(A3): implement all functions below

import { resolve, sep } from 'node:path';

/**
 * Asserts that homeDir is strictly under scratchDir.
 * This is the hard safety guard called before any subprocess spawn.
 * @param {string} homeDir
 * @param {string} scratchDir
 */
export function assertSafeHome(homeDir, scratchDir) {
  const resolved = resolve(scratchDir);
  if (!resolve(homeDir).startsWith(resolved + sep)) {
    throw new Error(
      `SAFETY: CRONTICK_HOME (${homeDir}) is not under ${resolved}. Refusing to proceed.`,
    );
  }
}

/**
 * Runs a child process with a timeout.
 * @param {string} execPath
 * @param {string[]} args
 * @param {{ cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean; inputData?: string }} options
 * @param {number} timeoutMs
 * @returns {Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>}
 */
export async function runWithTimeout(execPath, args, options, timeoutMs) {
  // TODO(A3): implement
  void execPath; void args; void options; void timeoutMs;
  throw new Error('runWithTimeout: not implemented');
}

/**
 * Synchronously sleeps for the given number of milliseconds.
 * @param {number} ms
 */
export function sleepSync(ms) {
  // TODO(A3): implement using Atomics.wait
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
}

/**
 * Returns true if a process with the given PID is alive.
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  // TODO(A3): implement
  void pid;
  throw new Error('isPidAlive: not implemented');
}

/**
 * Removes a path with retries (handles Windows file locking).
 * @param {string} targetPath
 * @param {{ attempts?: number; backoffMs?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function rmWithRetry(targetPath, opts = {}) {
  // TODO(A3): implement
  void targetPath;
  void opts;
  throw new Error('rmWithRetry: not implemented');
}
