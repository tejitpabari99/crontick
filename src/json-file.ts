import { readFileSync } from 'node:fs';
import { CrontickError } from './errors.js';

export interface JsonFileReadOptions {
  errorCode: string;
  subject: string;
  expectedShape: string;
}

interface JsonParseLocation {
  position?: number;
  line?: number;
  column?: number;
}

interface JsonParseDiagnostic {
  location: JsonParseLocation;
  reason: string;
}

type JsonFrame =
  | { type: 'object'; state: 'keyOrEnd' | 'colon' | 'value' | 'commaOrEnd'; afterComma: boolean }
  | { type: 'array'; state: 'valueOrEnd' | 'commaOrEnd'; afterComma: boolean };

export function readJsonFile(filePath: string, options: JsonFileReadOptions): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new CrontickError(
      options.errorCode,
      `Failed to read ${options.subject} ${filePath}: ${errorMessage(err)}`,
      { path: filePath, expectedShape: options.expectedShape },
    );
  }

  const normalized = text.startsWith('\uFEFF') ? text.slice(1) : text;
  try {
    return JSON.parse(normalized);
  } catch (err) {
    const diagnostic = buildJsonParseDiagnostic(err, normalized);
    throw new CrontickError(
      options.errorCode,
      `Failed to parse ${options.subject} ${filePath}${formatLocation(diagnostic.location)}: ${diagnostic.reason}; ${options.expectedShape}`,
      { path: filePath, expectedShape: options.expectedShape, ...diagnostic.location },
    );
  }
}

function buildJsonParseDiagnostic(err: unknown, text: string): JsonParseDiagnostic {
  const reason = jsonParseReason(err);
  const location = parseJsonParseLocation(err, text);
  if (!isUnexpectedEndReason(reason)) return { location, reason };

  const eofLocation = location.position === undefined ? endOfInputLocation(text) : location;
  const hint = inferUnexpectedEndHint(text);
  return { location: eofLocation, reason: hint ? `${reason} (${hint})` : reason };
}

function parseJsonParseLocation(err: unknown, text: string): JsonParseLocation {
  const message = errorMessage(err);
  const match = / at position (?<position>\d+)(?: \(line (?<line>\d+) column (?<column>\d+)\))?$/u.exec(message);
  if (!match?.groups?.position) return {};

  const position = Number.parseInt(match.groups.position, 10);
  const line = match.groups.line ? Number.parseInt(match.groups.line, 10) : undefined;
  const column = match.groups.column ? Number.parseInt(match.groups.column, 10) : undefined;
  if (line !== undefined && column !== undefined) return { position, line, column };

  return { position, ...lineAndColumnForPosition(text, position) };
}

function endOfInputLocation(text: string): JsonParseLocation {
  return { position: text.length, ...lineAndColumnForPosition(text, text.length) };
}

function lineAndColumnForPosition(text: string, position: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(position, text.length));
  const prefix = text.slice(0, clamped);
  const lines = prefix.split(/\n/u);
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

function inferUnexpectedEndHint(text: string): string | undefined {
  const frames: JsonFrame[] = [];
  let position = 0;
  let rootState: 'value' | 'done' = 'value';

  while (true) {
    position = skipWhitespace(text, position);
    if (position >= text.length) break;

    const frame = frames.at(-1);
    if (!frame) {
      if (rootState === 'done') return undefined;
      const value = scanJsonValue(text, position);
      if (value.incompleteHint) return value.incompleteHint;
      position = value.next;
      if (value.frame) {
        frames.push(value.frame);
      } else {
        rootState = completeValue(frames, rootState);
      }
      continue;
    }

    if (frame.type === 'object') {
      if (frame.state === 'keyOrEnd') {
        if (text[position] === '}') {
          frames.pop();
          position += 1;
          rootState = completeValue(frames, rootState);
          continue;
        }
        if (text[position] === '"') {
          const end = scanString(text, position);
          if (end === undefined) return 'unterminated string; expected closing "';
          frame.state = 'colon';
          frame.afterComma = false;
          position = end;
          continue;
        }
        return undefined;
      }

      if (frame.state === 'colon') {
        if (text[position] === ':') {
          frame.state = 'value';
          position += 1;
          continue;
        }
        return undefined;
      }

      if (frame.state === 'value') {
        const value = scanJsonValue(text, position);
        if (value.incompleteHint) return value.incompleteHint;
        position = value.next;
        if (value.frame) {
          frames.push(value.frame);
        } else {
          rootState = completeValue(frames, rootState);
        }
        continue;
      }

      if (text[position] === ',') {
        frame.state = 'keyOrEnd';
        frame.afterComma = true;
        position += 1;
        continue;
      }
      if (text[position] === '}') {
        frames.pop();
        position += 1;
        rootState = completeValue(frames, rootState);
        continue;
      }
      return undefined;
    }

    if (frame.state === 'valueOrEnd') {
      if (text[position] === ']') {
        frames.pop();
        position += 1;
        rootState = completeValue(frames, rootState);
        continue;
      }
      const value = scanJsonValue(text, position);
      if (value.incompleteHint) return value.incompleteHint;
      position = value.next;
      if (value.frame) {
        frames.push(value.frame);
      } else {
        rootState = completeValue(frames, rootState);
      }
      continue;
    }

    if (text[position] === ',') {
      frame.state = 'valueOrEnd';
      frame.afterComma = true;
      position += 1;
      continue;
    }
    if (text[position] === ']') {
      frames.pop();
      position += 1;
      rootState = completeValue(frames, rootState);
      continue;
    }
    return undefined;
  }

  return finalizeUnexpectedEndHint(frames, rootState);
}

function skipWhitespace(text: string, position: number): number {
  let next = position;
  while (next < text.length && /\s/u.test(text[next])) next += 1;
  return next;
}

function scanJsonValue(text: string, position: number): {
  next: number;
  frame?: JsonFrame;
  incompleteHint?: string;
} {
  const char = text[position];
  if (char === '{') {
    return { next: position + 1, frame: { type: 'object', state: 'keyOrEnd', afterComma: false } };
  }
  if (char === '[') {
    return { next: position + 1, frame: { type: 'array', state: 'valueOrEnd', afterComma: false } };
  }
  if (char === '"') {
    const end = scanString(text, position);
    return end === undefined
      ? { next: text.length, incompleteHint: 'unterminated string; expected closing "' }
      : { next: end };
  }
  return scanPrimitiveValue(text, position);
}

function scanString(text: string, position: number): number | undefined {
  let escaped = false;
  for (let index = position + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') return index + 1;
  }
  return undefined;
}

function scanPrimitiveValue(text: string, position: number): {
  next: number;
  incompleteHint?: string;
} {
  let next = position;
  while (next < text.length && !/[\s,\]}]/u.test(text[next])) next += 1;
  const token = text.slice(position, next);
  if (next < text.length) return { next };
  return isCompleteJsonPrimitive(token)
    ? { next }
    : { next, incompleteHint: inferPrimitiveEofHint(token) };
}

function isCompleteJsonPrimitive(token: string): boolean {
  if (token.length === 0) return false;
  try {
    const parsed = JSON.parse(token);
    return typeof parsed !== 'object' || parsed === null;
  } catch {
    return false;
  }
}

function inferPrimitiveEofHint(token: string): string {
  if ('true'.startsWith(token) && token !== 'true') return 'unterminated value; expected literal true';
  if ('false'.startsWith(token) && token !== 'false') return 'unterminated value; expected literal false';
  if ('null'.startsWith(token) && token !== 'null') return 'unterminated value; expected literal null';
  return 'unterminated value; expected a complete JSON value';
}

function completeValue(frames: JsonFrame[], rootState: 'value' | 'done'): 'value' | 'done' {
  const frame = frames.at(-1);
  if (!frame) return 'done';
  frame.state = 'commaOrEnd';
  frame.afterComma = false;
  return rootState;
}

function finalizeUnexpectedEndHint(frames: JsonFrame[], rootState: 'value' | 'done'): string | undefined {
  const frame = frames.at(-1);
  if (!frame) return rootState === 'value' ? 'unterminated value; expected a JSON value' : undefined;
  if (frame.type === 'object') {
    if (frame.state === 'keyOrEnd') {
      return frame.afterComma
        ? "trailing comma with no following property name or closing '}'"
        : "unterminated object; expected a property name or closing '}'";
    }
    if (frame.state === 'colon') return "unterminated object; expected ':' after property name";
    if (frame.state === 'value') return "unterminated object; expected a value after ':'";
    return "unterminated object; expected ',' or closing '}'";
  }
  if (frame.state === 'valueOrEnd') {
    return frame.afterComma
      ? "trailing comma with no following value or closing ']'"
      : "unterminated array; expected a value or closing ']'";
  }
  return "unterminated array; expected ',' or closing ']'";
}

function formatLocation(location: JsonParseLocation): string {
  if (location.position === undefined) return '';
  if (location.line !== undefined && location.column !== undefined) {
    return ` at line ${location.line} column ${location.column} (position ${location.position})`;
  }
  return ` at position ${location.position}`;
}

function jsonParseReason(err: unknown): string {
  const message = errorMessage(err);
  return message.replace(/ at position \d+(?: \(line \d+ column \d+\))?$/u, '');
}

function isUnexpectedEndReason(reason: string): boolean {
  return /unexpected end of (?:json )?input/iu.test(reason);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
