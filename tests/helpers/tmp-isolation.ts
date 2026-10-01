/**
 * Vitest global setup/teardown: confines every temp dir created during the run
 * (test files, spawned daemons, their children) to one run-scoped root
 * `<os tmpdir>/crontick-vitest-XXXX` by pointing TMPDIR/TMP/TEMP at it before
 * workers start. After the run, teardown kills any process tied to that root
 * (never anything outside it), removes the root, and fails the run if a leak
 * is still detected. See docs/testing/testing.md "Cleaning up after tests".
 */
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cleanTargets, findLeakedPids, TEMP_PREFIX } from '../../scripts/clean-test.mjs';

const VARS = ['TMPDIR', 'TMP', 'TEMP'] as const;
const saved: Record<string, string | undefined> = {};
let root: string | undefined;

export function setup(): void {
  const realTmp = realpathSync(tmpdir());
  root = mkdtempSync(join(realTmp, `${TEMP_PREFIX}vitest-`));
  for (const v of VARS) {
    saved[v] = process.env[v];
    process.env[v] = root;
  }
}

export async function teardown(): Promise<void> {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  if (!root) return;
  const targets = [root, resolve('.crontick')];
  const reaped = findLeakedPids(targets);
  if (reaped.length) {
    // Not a failure (they are reaped below) but a test is missing its own cleanup.
    console.warn(`[tmp-isolation] reaping ${reaped.length} test process(es) a test failed to stop: ${reaped.map((p) => { try { return p + ':' + readFileSync(`/proc/${p}/cmdline`, 'utf-8').replace(/\0/g, ' ').slice(0, 120); } catch { return String(p); } }).join(' | ')}`);
  }
  const leaked = await cleanTargets([root]);
  root = undefined;
  // Some suites keep scratch homes in the repo-local, git-ignored `.crontick/`.
  // Kill daemons still tied to it (the dirs themselves are kept).
  const scratch = await cleanTargets([resolve('.crontick')], { remove: false });
  leaked.pids.push(...scratch.pids);
  if (leaked.pids.length || leaked.dirs.length) {
    console.error(
      `[tmp-isolation] TEST LEAK: processes=[${leaked.pids.join(',')}] dirs=[${leaked.dirs.join(',')}]. ` +
        'Run `npm run clean:test`.',
    );
    process.exitCode = 1;
  }
}
