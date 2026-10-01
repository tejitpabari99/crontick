/**
 * Cleaned, human-readable "output" view of a run, built from the engine's stdout/stderr.
 *
 * crontick does not store the engine's raw logs: the runner (e.g. Claude) keeps its own
 * transcript. While a run executes, the daemon parses the engine's stdout line by line as it
 * arrives (see `src/daemon/output-collector.ts`) and keeps only the final `result` event and
 * stderr (capped); everything else (tool calls, interim assistant text, system events) is
 * discarded immediately. This module holds the persisted/returned shapes and the pure helpers
 * shared by every layer (daemon, tests).
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

/** The parsed engine output persisted per run (see `Store.setRunOutput`). */
export interface EngineOutput {
  /** `claude-stream-json` when engine stdout was Claude stream-json events; `text` for plain engine output. */
  format: 'claude-stream-json' | 'text';
  /** The engine's final answer (Claude `result` event text; plain stdout for text engines); `null` when there is none. */
  result: string | null;
  /** Error reported by the engine's final `result` event (`is_error`); `null` otherwise. */
  engineError: string | null;
  /** Engine stderr (redacted, capped at `DEFAULT_MAX_STDERR_BYTES_PER_RUN`). */
  stderr: string;
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
  /** Engine stderr (redacted, capped), for diagnosing failures. */
  stderr: string;
  sessionId: string | null;
  costUsd: number | null;
  turns: number | null;
  durationMs: number | null;
  /** Display-only normalized token counts from the stored usage block; `null` when the run has none. */
  usage: NormalizedUsage | null;
  /** Absolute path of the per-job crontick log file (crontick-side events only); `null` when file logging is disabled. Added by the daemon route, not by `buildRunOutput`. */
  logFile?: string | null;
  /** True when a text engine's stdout hit `retention.maxOutputBytesPerRun`, or stderr hit its cap, and was cut. */
  truncated: boolean;
}

const BASE64_RUN = /[A-Za-z0-9+/]{120,}={0,2}/g;
const HOOK_EVAL = /eval\(Buffer\.from\((['"])[A-Za-z0-9+/=]+\1\s*,\s*(['"])base64\2\)[^)]*\)\)?/g;

/** Remove noise that is meaningless to a reader: base64 hook payloads and long opaque blobs; then apply secret redaction. */
export function cleanOutputText(text: string): string {
  return redactText(text.replace(HOOK_EVAL, 'eval(<hook payload omitted>)').replace(BASE64_RUN, '<base64 omitted>'));
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const EMPTY_ENGINE_OUTPUT: EngineOutput = { format: 'text', result: null, engineError: null, stderr: '' };

/** Build the output view for a run from its record and its persisted engine output (absent for runs that never spawned an engine). */
export function buildRunOutput(run: RunOutputSource, engine: EngineOutput = EMPTY_ENGINE_OUTPUT): RunOutput {
  const error = run.error ?? engine.engineError;
  return {
    runId: run.id,
    status: run.status,
    format: engine.format,
    result: engine.result,
    error: error === null || error === undefined ? null : cleanOutputText(error),
    stderr: engine.stderr,
    sessionId: run.sessionId ?? null,
    costUsd: run.costUsd ?? null,
    turns: run.turns ?? null,
    durationMs: run.durationMs ?? null,
    usage: normalizeUsageJson(run.usageJson),
    truncated: run.outputTruncated === true,
  };
}
