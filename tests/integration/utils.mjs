// utils.mjs — shared harness utilities

import { spawn } from 'node:child_process';
import { rmSync, readFileSync } from 'node:fs';
import { resolve, sep, join } from 'node:path';

/**
 * Asserts that homeDir is strictly under scratchDir.
 * Uses sep-suffix so `.e2e-scratch-evil` does NOT match `.e2e-scratch`.
 * @param {string} homeDir
 * @param {string} scratchDir
 */
export function assertSafeHome(homeDir, scratchDir) {
  const resolvedScratch = resolve(scratchDir);
  if (!resolve(homeDir).startsWith(resolvedScratch + sep)) {
    throw new Error(
      `SAFETY: CRONTICK_HOME (${homeDir}) is not under ${resolvedScratch}. Refusing to proceed.`,
    );
  }
}

/**
 * Spawn cmd with a timeout. Captures stdout/stderr. Supports inputData piped to stdin.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string; env?: object; inputData?: string }} options
 * @param {number} timeoutMs
 * @returns {Promise<{ exitCode: number|null; stdout: string; stderr: string; timedOut: boolean }>}
 */
export function runWithTimeout(cmd, args, options, timeoutMs) {
  return new Promise((resolvePromise) => {
    const { inputData, ...spawnOptions } = options ?? {};
    const child = spawn(cmd, args, { shell: false, ...spawnOptions });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    if (inputData !== undefined) {
      child.stdin?.write(inputData);
      child.stdin?.end();
    }

    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolvePromise({ exitCode: code, stdout, stderr, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 3000);
    }, timeoutMs);

    child.on('exit', (code) => { clearTimeout(timer); finish(code); });
    child.on('error', (err) => { clearTimeout(timer); stderr += String(err); finish(null); });
  });
}

/**
 * Synchronous sleep via Atomics.wait (no CPU spin).
 * @param {number} ms
 */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Async sleep (Promise + setTimeout). For use in async poll loops.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Returns true if a process with the given PID is alive.
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursive rmSync with retries for Windows file-handle lock delays.
 * @param {string} targetPath
 * @param {number} [attempts=5]
 * @param {number} [delayMs=300]
 */
export function rmWithRetry(targetPath, attempts = 5, delayMs = 300) {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      sleepSync(delayMs);
    }
  }
}

/**
 * Resolves a bin's JS entry path from the installed package in scratchDir.
 * @param {string} scratchDir
 * @param {string} binName
 * @returns {string} absolute path to the JS file
 */
export function resolveInstalledBin(scratchDir, binName) {
  const pkgPath = join(scratchDir, 'node_modules', 'crontick', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const relPath = pkg.bin?.[binName];
  if (!relPath) throw new Error(`Installed package.json has no "${binName}" bin entry`);
  return join(scratchDir, 'node_modules', 'crontick', relPath);
}
