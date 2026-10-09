import { readFileSync } from 'node:fs';
import { CrontickError } from '../errors.js';
import { parseTriggerPayload } from '../utils/trigger-payload.js';

export interface PayloadSourceIo {
  readFile(path: string): string;
  readStdin(): string;
}

export const realPayloadSourceIo: PayloadSourceIo = {
  readFile: (path) => readFileSync(path, 'utf-8'),
  readStdin: () => readFileSync(0, 'utf-8'),
};

/** Resolves `--payload <json>|@file|-` to a parsed JSON value (undefined when the flag is absent). */
export function resolvePayloadArg(arg: string | undefined, io: PayloadSourceIo = realPayloadSourceIo): unknown {
  if (arg === undefined) return undefined;
  let text = arg;
  try {
    if (arg === '-') text = io.readStdin();
    else if (arg.startsWith('@')) text = io.readFile(arg.slice(1));
  } catch (err) {
    throw new CrontickError('INVALID_PAYLOAD', `Cannot read payload from ${arg === '-' ? 'stdin' : arg.slice(1)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseTriggerPayload(text);
}
