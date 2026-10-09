/**
 * CLI helpers for `config` commands: the in-flight-run choice (flags, or an
 * interactive prompt on a TTY) and flat list/get formatting. No config logic:
 * the client decides everything; this only asks the human and formats output.
 */
import { CrontickError } from '../errors.js';
import type { ConfigWriteOptions } from '../client.js';
import { terminalTrustPromptIo, type TrustPromptIo } from './trust-prompt.js';

type InFlightChoice = NonNullable<ConfigWriteOptions['inFlight']>;

export type InFlightIo = TrustPromptIo;
export const terminalInFlightIo = terminalTrustPromptIo;

export interface InFlightFlags {
  stopRunning?: boolean;
  waitRunning?: boolean;
}

/**
 * Runs `write(inFlight)`. `--stop-running`/`--wait-running` pick the choice up
 * front. Otherwise a RUNS_IN_FLIGHT failure prompts on a TTY (stop / wait /
 * cancel) and retries; non-interactive sessions rethrow with flag guidance.
 */
export async function writeConfigWithInFlight<T>(
  write: (inFlight?: InFlightChoice) => Promise<T>,
  flags: InFlightFlags,
  io: InFlightIo,
  /** `daemon` (config saves, default) or `job` (job updates): only changes the wording of the prompt. */
  options: { subject?: 'daemon' | 'job' } = {},
): Promise<T> {
  if (flags.stopRunning && flags.waitRunning) {
    throw new CrontickError('VALIDATION_ERROR', 'Use only one of --stop-running and --wait-running.');
  }
  const chosen: InFlightChoice | undefined = flags.stopRunning ? 'stop' : flags.waitRunning ? 'wait' : undefined;
  if (chosen) return write(chosen);
  try {
    return await write(undefined);
  } catch (err) {
    if (!(err instanceof CrontickError) || err.code !== 'RUNS_IN_FLIGHT') throw err;
    if (!io.interactive) {
      throw new CrontickError(
        'RUNS_IN_FLIGHT',
        `${err.message} Re-run with --stop-running (cancel them, then apply) or --wait-running (pause, wait for them, apply, resume).`,
        err.details,
      );
    }
    const runs = (err.details as { runs?: unknown[] } | undefined)?.runs ?? [];
    const paused = options.subject === 'job' ? 'job paused' : 'daemon paused';
    const answer = (await io.ask(
      `${runs.length} run(s) in flight. [s]top them and apply, [w]ait for them (${paused}) then apply, or [c]ancel? (s/w/C) `,
    )).trim().toLowerCase();
    if (answer === 's' || answer === 'stop') return write('stop');
    if (answer === 'w' || answer === 'wait') return write('wait');
    throw new CrontickError('CONFIRMATION_DECLINED', `Not confirmed; the ${options.subject === 'job' ? 'job' : 'config'} was not changed.`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Flat `key = value` lines of the effective config; keys absent from the stored file are tagged `(default)`. */
export function flattenConfigLines(config: unknown, stored: unknown, prefix = ''): string[] {
  const lines: string[] = [];
  const walk = (node: unknown, storedNode: unknown, path: string): void => {
    if (isPlainObject(node) && Object.keys(node).length > 0) {
      for (const [key, child] of Object.entries(node)) {
        walk(child, isPlainObject(storedNode) ? storedNode[key] : undefined, path ? `${path}.${key}` : key);
      }
      return;
    }
    lines.push(`${path} = ${JSON.stringify(node)}${storedNode === undefined ? ' (default)' : ''}`);
  };
  walk(config, stored, prefix);
  return lines;
}

/** Strings print raw, everything else as compact JSON. */
export function formatConfigValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
