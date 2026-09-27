/**
 * Shared fake prompt-engine helpers for tests.
 *
 * crontick is prompt-only: every job action is `kind: "prompt"`, which
 * resolves to a configured engine command at run time (see
 * src/config.ts#buildPromptRunCommand). Many tests only need *some* process
 * to spawn and behave predictably (exit with a given code, write output,
 * sleep, read env/cwd) — they don't care about a real external AI CLI.
 *
 * The fixture engine here is `process.execPath` (node) invoked with `-e`, so
 * the job's `prompt` text IS the JS to evaluate. This lets tests express
 * exactly the same inline scripts that used to be written as `exec`/`script`
 * action jobs (e.g. `process.exit(1)`, `setTimeout(() => {}, 30000)`,
 * `process.stdout.write("hi")`), without needing a real engine binary
 * installed and without a separate fixture script file per behavior.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Engine name tests should reference via `action.engine` (or as `defaultEngine`). */
export const FAKE_ENGINE_NAME = 'node-fake';

/** `{ command, args }` for the fake engine: `node -e <prompt-text>`. */
export const FAKE_ENGINE_CONFIG = Object.freeze({
  command: process.execPath,
  args: ['-e'],
  env: {},
});

/**
 * Writes a crontick `config.json` into `dir` (a CRONTICK_HOME-style data
 * directory) that registers the fake engine as an available engine (NOT as
 * `defaultEngine` -- that stays `copilot`, from `BUILT_IN_CONFIG`, so tests
 * asserting the built-in default engine name are unaffected). Callers that
 * need the fake engine must reference it explicitly via `engine:
 * FAKE_ENGINE_NAME`. `overrides` is shallow-merged over the top-level config
 * object (e.g. to add `retention`/`logging` overrides).
 */
export function writeFakeEngineConfig(dir: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, 'config.json'),
    `${JSON.stringify(
      {
        engines: { [FAKE_ENGINE_NAME]: FAKE_ENGINE_CONFIG },
        ...overrides,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
}
