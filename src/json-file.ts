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
    const location = parseJsonParseLocation(err, normalized);
    throw new CrontickError(
      options.errorCode,
      `Failed to parse ${options.subject} ${filePath}${formatLocation(location)}: ${jsonParseReason(err)}; ${options.expectedShape}`,
      { path: filePath, expectedShape: options.expectedShape, ...location },
    );
  }
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

function lineAndColumnForPosition(text: string, position: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(position, text.length));
  const prefix = text.slice(0, clamped);
  const lines = prefix.split(/\n/u);
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
