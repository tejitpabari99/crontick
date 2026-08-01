// api-driver.mjs — executes library calls via a generated scratch .mjs script

import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertSafeHome, runWithTimeout } from '../utils.mjs';

/** Default API timeout in milliseconds. */
const API_TIMEOUT_MS = 30_000;

/**
 * Executes a JavaScript snippet in the installed crontick package context.
 * The snippet has access to `crontick.*` (all public exports).
 *
 * @param {string} scriptBody - JS expression/block; use `crontick.createClient()`, etc.
 * @param {{ scratchDir: string; testHome: string; bins?: object; env?: Record<string, string> }} ctx
 * @returns {Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; parsed: unknown }>}
 */
export async function runApi(scriptBody, ctx) {
  const { scratchDir, testHome, env = {} } = ctx;
  assertSafeHome(testHome, scratchDir);

  const scriptPath = join(
    scratchDir,
    `api-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
  );

  const scriptContent = `import * as crontick from 'crontick';
const result = await (async () => {
${scriptBody}
})();
process.stdout.write(JSON.stringify(result ?? null));
`;

  writeFileSync(scriptPath, scriptContent, 'utf-8');

  let r;
  try {
    r = await runWithTimeout(
      process.execPath,
      [scriptPath],
      {
        cwd: scratchDir,
        env: { ...process.env, CRONTICK_HOME: testHome, ...env },
        shell: false,
      },
      API_TIMEOUT_MS,
    );
  } finally {
    try { rmSync(scriptPath, { force: true }); } catch { /* best-effort */ }
  }

  const parsed = r.exitCode === 0 ? JSON.parse(r.stdout || 'null') : null;
  return { ...r, parsed };
}
