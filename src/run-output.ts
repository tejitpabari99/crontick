/**
 * Cleaned, human-readable "output" view of a run, built from the raw engine log.
 *
 * Where the raw log comes from: the runner captures the engine child process's
 * stdout/stderr chunk by chunk into the SQLite `run_logs` table (and mirrors it
 * to `<logsDir>/<jobId>.log`). For a Claude engine, stdout is `stream-json`: one
 * JSON event per line (system/hook events, assistant messages with `thinking`
 * blocks carrying opaque `signature` blobs, tool calls/results, and a final
 * `result`). That is faithful but unreadable, so this module parses it into the
 * final answer plus the assistant's text (segments separated by `---`),
 * dropping thinking blocks, tool calls/results, hook plumbing and base64 payloads. The raw log stays available unchanged through
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
  usageJson?: string;
  outputTruncated?: boolean;
}

/** Stable, display-only token counts derived from an engine's raw usage block. Missing or non-numeric fields are `undefined`. */
export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  thinkingTokens?: number;
}

function counter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Map Claude's raw `usage` object (the stored `usageJson`, parsed) to display
 * token counts. Top-level counters are the run total; `iterations[]` is ignored.
 * Non-object input yields all-undefined fields. Storage keeps the raw block.
 */
export function normalizeUsage(usage: unknown): NormalizedUsage {
  const u = asRecord(usage);
  if (!u) return {};
  const out: NormalizedUsage = {};
  const input = counter(u['input_tokens']);
  const output = counter(u['output_tokens']);
  const cacheRead = counter(u['cache_read_input_tokens']);
  const cacheCreation = counter(u['cache_creation_input_tokens']);
  const thinking = counter(asRecord(u['output_tokens_details'])?.['thinking_tokens']);
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (cacheRead !== undefined) out.cacheReadTokens = cacheRead;
  if (cacheCreation !== undefined) out.cacheCreationTokens = cacheCreation;
  if (thinking !== undefined) out.thinkingTokens = thinking;
  return out;
}

/** Normalize a stored `usageJson` string; `null` when absent or unparseable. */
export function normalizeUsageJson(usageJson: string | undefined): NormalizedUsage | null {
  if (usageJson === undefined) return null;
  try {
    return normalizeUsage(JSON.parse(usageJson));
  } catch {
    return null;
  }
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
  /**
   * Assistant text only: consecutive text blocks form one segment, a tool call between texts ends a segment, and
   * segments are joined by a `---` line. No tool markers, thinking, hooks or tool results (the raw log has those).
   * Plain-text engines keep their stdout lines as-is. `''` when there is no text.
   */
  output: string;
  /** Engine stderr (redacted, last {@link STDERR_MAX} characters), for diagnosing failures. */
  stderr: string;
  sessionId: string | null;
  costUsd: number | null;
  turns: number | null;
  durationMs: number | null;
  /** Display-only normalized token counts from the stored usage block; `null` when the run has none. */
  usage: NormalizedUsage | null;
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
  /** Assistant text segments; a `tool_use` between texts ends a segment. */
  segments: string[];
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
    sawEvents: false, segments: [], plain: [], lastAssistantText: undefined,
    resultText: undefined, resultIsError: false, assistantError: undefined,
  };
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) parsed.segments.push(current.join('\n\n'));
    current = [];
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
            current.push(block['text'].trim());
          } else if (block['type'] === 'tool_use') {
            flush();
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
  flush();
  return parsed;
}

/** Separator between assistant text segments that a tool call interrupted. */
export const SEGMENT_SEPARATOR = '\n\n---\n\n';

/** Join assistant text segments with {@link SEGMENT_SEPARATOR} (no leading/trailing separator; `''` when empty). Each segment is redacted. */
export function joinSegments(segments: readonly string[]): string {
  return segments.map((seg) => cleanOutputText(seg.trim())).filter((seg) => seg !== '').join(SEGMENT_SEPARATOR);
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

  let output = format === 'claude-stream-json' ? joinSegments(p.segments) : cleanOutputText(p.plain.join('\n').trim());
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
    usage: normalizeUsageJson(run.usageJson),
    truncated,
  };
}
