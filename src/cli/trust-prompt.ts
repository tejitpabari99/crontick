/**
 * Interactive Claude folder-trust prompt for the CLI. The decision to ask lives
 * in the client (it throws TRUST_REQUIRED before persisting anything); this
 * shim only asks the human and retries the same call with `trustFolder: true`.
 * Streams are injectable so the prompt is unit-testable without a TTY.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { CrontickError } from '../errors.js';

export interface TrustPromptIo {
  /** True only when both stdin and stdout are terminals. */
  interactive: boolean;
  /** Prints the question and resolves with the typed answer. */
  ask(question: string): Promise<string>;
}

/** Real-terminal IO over the given streams (defaults to the process's own). */
export function terminalTrustPromptIo(
  input: Readable & { isTTY?: boolean } = process.stdin,
  output: Writable & { isTTY?: boolean } = process.stdout,
): TrustPromptIo {
  return {
    interactive: input.isTTY === true && output.isTTY === true,
    ask(question) {
      const rl = createInterface({ input, output });
      return new Promise((resolve) => {
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer);
        });
      });
    },
  };
}

/**
 * Runs `operation(trustFolder)`. If it fails with TRUST_REQUIRED and the session
 * is interactive, asks `Folder X is not trusted by Claude. Trust it? (y/N)`;
 * `y`/`yes` retries with trustFolder:true, anything else aborts with
 * TRUST_DECLINED (nothing was created). Non-interactive sessions rethrow the
 * original error, whose text already says to re-run with --trust-folder.
 */
export async function withTrustPrompt<T>(
  operation: (trustFolder: boolean) => Promise<T>,
  options: { trustFolder?: boolean; io: TrustPromptIo },
): Promise<T> {
  try {
    return await operation(options.trustFolder === true);
  } catch (err) {
    if (!(err instanceof CrontickError) || err.code !== 'TRUST_REQUIRED' || !options.io.interactive) throw err;
    const details = (err.details ?? {}) as { cwd?: string; folders?: string[] };
    const folders = details.folders && details.folders.length > 0 ? details.folders : details.cwd ? [details.cwd] : [];
    const question = folders.length > 1
      ? `Folders not trusted by Claude:\n${folders.map((folder) => `  ${folder}`).join('\n')}\nTrust them all? (y/N) `
      : `Folder ${folders[0] ?? '(unknown)'} is not trusted by Claude. Trust it? (y/N) `;
    const answer = (await options.io.ask(question)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      throw new CrontickError('TRUST_DECLINED', 'Folder was not trusted; nothing was created or changed.', err.details);
    }
    return operation(true);
  }
}
