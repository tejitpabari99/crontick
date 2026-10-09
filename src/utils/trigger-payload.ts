import { CrontickError } from '../errors.js';

/** Parses a `jobs trigger` payload: any valid JSON value; otherwise INVALID_PAYLOAD. */
export function parseTriggerPayload(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new CrontickError('INVALID_PAYLOAD', `Payload must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}
