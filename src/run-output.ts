/**
 * Cleaned, human-readable "output" view of a run, built from the raw engine log.
 *
 * Where the raw log comes from: the runner captures the engine child process's
 * stdout/stderr chunk by chunk into the SQLite `run_logs` table (and mirrors it
 * to `<logsDir>/<jobId>.log`). For a Claude engine, stdout is `stream-json`: one
 * JSON event per line (system/hook events, assistant messages with `thinking`
 * blocks carrying opaque `signature` blobs, tool calls/results, and a final
 * `result`). That is faithful but unreadable, so this module parses it into the
 * final answer plus a readable transcript, dropping thinking blocks, hook
 * plumbing and base64 payloads. The raw log stays available unchanged through
 * `getLogs`. Pure and dependency-light so every layer (daemon route, tests) can use it.
 */
import { redactText } from './logger.js';

export interface RunOutputSource {
  id: string;
  status: string;
  error?: string;
  sessionId?: string;
  costUsd?: number;
  turns?: number;
  durationMs?: number;
  outputTruncated?: boolean;
}

export interface RunOutputLogChunk {
  stream: string;
  data: string;
}

/** Parsed output view returned by `getOutput` / `GET /api/runs/:id/output`. */
export interface RunOutput {
  runId: string;
  status: string;
  /** `claude-stream-json` when engine stdout was parsed as Claude stream-json events; `text` for plain engine output. */
  format: 'claude-stream-json' | 'text';
  /** The engine's final answer (Claude `result` text, else the last assistant text, else plain stdout). `null` when the run produced none. */
  result: string | null;
  /** Error message, if any: the run's recorded error, else an error reported in the engine output. `null` when there is none. */
  error: string | null;
  /** Readable transcript: assistant text and one-line tool markers; thinking blocks, hook payloads and signatures removed. */
  output: string;
  /** Engine stderr (redacted, last {@link STDERR_MAX} characters), for diagnosing failures. */
  stderr: string;
  sessionId: string | null;
  costUsd: number | null;
  turns: number | null;
  durationMs: number | null;
  /** True when the run's captured output hit `retention.maxOutputBytesPerRun` (the transcript may be incomplete) or this view was itself capped. */
  truncated: boolean;
}

export const OUTPUT_MAX = 200_000;
export const STDERR_MAX = 4_000;

const BASE64_RUN = /[A-Za-z0-9+/]{120,}={0,2}/g;
const HOOK_EVAL = /eval\(Buffer\.from\((['"])[A-Za-z0-9+/=]+\1\s*,\s*(['"])base64\2\)[^)]*\)\)?/g;

/** Remove noise that is meaningless to a reader: base64 hook payloads and long opaque blobs; then apply secret redaction. */
export function cleanOutputText(text: string): string {
  return redactText(text.replace(HOOK_EVAL, 'eval(<hook payload omitted>)').replace(BASE64_RUN, '<base64 omitted>'));
}

interface ParsedStdout {
  sawEvents: boolean;
  transcript: string[];
  plain: string[];
  lastAssistantText: string | undefined;
  resultText: string | undefined;
  resultIsError: boolean;
  assistantError: string | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseStdout(stdout: string): ParsedStdout {
  const parsed: ParsedStdout = {
    sawEvents: false, transcript: [], plain: [], lastAssistantText: undefined,
    resultText: undefined, resultIsError: false, assistantError: undefined,
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let event: Record<string, unknown> | undefined;
    if (line.trimStart().startsWith('{')) {
      try {
        event = asRecord(JSON.parse(line));
      } catch {
        event = undefined;
      }
    }
    if (!event || typeof event['type'] !== 'string') {
      parsed.plain.push(line);
      parsed.transcript.push(line);
      continue;
    }
    parsed.sawEvents = true;
    const type = event['type'];
    if (type === 'assistant') {
      const content = asRecord(event['message'])?.['content'];
      const texts: string[] = [];
      if (Array.isArray(content)) {
        for (const raw of content) {
          const block = asRecord(raw);
          if (!block) continue;
          if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim() !== '') {
            texts.push(block['text']);
            parsed.transcript.push(block['text']);
          } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
            parsed.transcript.push(`[tool] ${block['name']}`);
          }
          // `thinking` / `redacted_thinking` blocks (and their `signature`) are intentionally dropped.
        }
      }
      if (texts.length > 0) parsed.lastAssistantText = texts.join('\n');
      if (typeof event['error'] === 'string' && texts.length > 0) parsed.assistantError = texts.join('\n');
    } else if (type === 'result') {
      if (typeof event['result'] === 'string') parsed.resultText = event['result'];
      parsed.resultIsError = event['is_error'] === true;
    }
    // system (hooks, init), user (tool results), stream_event and unknown types carry no reader-facing output.
  }
  return parsed;
}

/** Build the cleaned output view for a run from its raw engine log chunks (stdout/stderr; other streams are ignored). */
export function buildRunOutput(run: RunOutputSource, logs: readonly RunOutputLogChunk[]): RunOutput {
  const stdout = logs.filter((l) => l.stream === 'stdout').map((l) => l.data).join('');
  const stderr = logs.filter((l) => l.stream === 'stderr').map((l) => l.data).join('');
  const p = parseStdout(stdout);

  const format: RunOutput['format'] = p.sawEvents ? 'claude-stream-json' : 'text';
  const plainText = p.plain.join('\n').trim();
  let result: string | undefined;
  if (format === 'claude-stream-json') {
    result = !p.resultIsError && p.resultText !== undefined && p.resultText !== '' ? p.resultText : p.lastAssistantText;
  } else {
    result = plainText === '' ? undefined : plainText;
  }
  const engineError = p.resultIsError ? p.resultText : p.assistantError;
  const error = run.error ?? engineError ?? null;

  let output = cleanOutputText(p.transcript.join('\n').trim());
  let truncated = run.outputTruncated === true;
  if (output.length > OUTPUT_MAX) {
    output = `${output.slice(0, OUTPUT_MAX)}\n[output view truncated]`;
    truncated = true;
  }
  let cleanResult = result === undefined ? null : cleanOutputText(result);
  if (cleanResult !== null && cleanResult.length > OUTPUT_MAX) {
    cleanResult = `${cleanResult.slice(0, OUTPUT_MAX)}\n[output view truncated]`;
    truncated = true;
  }
  const cleanStderr = cleanOutputText(stderr.trim());

  return {
    runId: run.id,
    status: run.status,
    format,
    result: cleanResult,
    error: error === null ? null : cleanOutputText(error),
    output,
    stderr: cleanStderr.length > STDERR_MAX ? cleanStderr.slice(-STDERR_MAX) : cleanStderr,
    sessionId: run.sessionId ?? null,
    costUsd: run.costUsd ?? null,
    turns: run.turns ?? null,
    durationMs: run.durationMs ?? null,
    truncated,
  };
}
