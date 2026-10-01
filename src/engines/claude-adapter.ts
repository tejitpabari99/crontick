import { randomUUID } from 'node:crypto';
import { buildClaudeHookCommand, claudeCompletionMarkerPath, claudeHookHelperPath, ensureClaudeHookHelper } from '../claude-completion-marker.js';
import { EngineAdapter, type EngineInvocation, type FolderTrustContext, type EngineOptions, type EngineResult, type StreamEvent, type TerminalEngineError } from './types.js';
import { resolveTranscriptPath } from './claude-transcript.js';
import { isFolderTrusted, trustFolder, type TrustDeps } from './claude-trust.js';

/** Bounds the ephemeral SessionEnd hook so it can never hold up shutdown. */
const HOOK_TIMEOUT_SEC = 10;

const AUTH_ERROR_PATTERN = /authenticat|unauthori[sz]ed|\b401\b|invalid[^.]{0,30}(api key|token)|oauth|token[^.]{0,20}expired/i;

/** Claude Code's non-interactive stream-json invocation. */
export class ClaudeAdapter extends EngineAdapter {
  constructor(private readonly trustDeps: TrustDeps = {}) {
    super();
  }

  isFolderTrusted(cwd: string, ctx: FolderTrustContext = {}): boolean {
    return isFolderTrusted(cwd, { ...this.trustDeps, ...(ctx.env ? { env: ctx.env } : {}) });
  }

  trustFolder(cwd: string, ctx: FolderTrustContext = {}): void {
    trustFolder(cwd, { ...this.trustDeps, ...(ctx.env ? { env: ctx.env } : {}) });
  }

  reservedArgs(): ReadonlySet<string> {
    return new Set(['-p', '--prompt', '--session-id', '-r', '--resume', '--continue', '--connect', '--output-format', '--settings']);
  }

  buildInvocation(prompt: string, opts: EngineOptions): EngineInvocation {
    const sessionId = opts.sessionId ?? randomUUID();
    // Internal command previews may omit run context; only an actual runner
    // supplies the stable run ID that restart reconciliation can look up.
    const markerPath = claudeCompletionMarkerPath(opts.dataDir || '.', opts.runId || randomUUID());
    // Claude runs command hooks through the platform shell. The hook is a plain
    // helper script (no eval, no embedded paths): the marker path is argv. If the
    // helper cannot be written or a path is unsafe, the hook is omitted: it is
    // best-effort and must never block a run. User settings are never edited.
    // Previews (no run context) describe the hook without touching disk.
    const dataDir = opts.dataDir || '.';
    const helperPath = opts.runId && opts.dataDir
      ? ensureClaudeHookHelper(dataDir)
      : claudeHookHelperPath(dataDir);
    const hookCommand = helperPath
      ? buildClaudeHookCommand(process.execPath, helperPath, markerPath)
      : undefined;
    const settings = hookCommand === undefined ? undefined : JSON.stringify({
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', timeout: HOOK_TIMEOUT_SEC, command: hookCommand }] }] },
    });
    return {
      command: opts.command,
      args: [
        ...opts.engineArgs,
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        ...(opts.sessionId ? ['--resume', sessionId] : ['--session-id', sessionId]),
        ...opts.args,
        ...(settings !== undefined ? ['--settings', settings] : []),
      ],
      env: { ...opts.env },
      sessionId,
    };
  }

  /**
   * Claude stream-json: one JSON object per line with a string `type`. Claude-specific
   * on purpose (the collector's generic default is plain text) so the two can diverge.
   */
  parseStreamEvent(line: string): StreamEvent | undefined {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const event = value as Record<string, unknown>;
    if (typeof event['type'] !== 'string') return undefined;
    return {
      type: event['type'],
      ...(typeof event['result'] === 'string' ? { result: event['result'] } : {}),
      isError: event['is_error'] === true,
    };
  }

  detectTerminalError(line: string): TerminalEngineError | undefined {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const event = value as Record<string, unknown>;

    if (event['type'] === 'result' && event['is_error'] === true) {
      const message = typeof event['result'] === 'string' && event['result'].length > 0
        ? event['result']
        : typeof event['subtype'] === 'string' ? event['subtype'] : 'Claude reported an error';
      return { message, retryable: !AUTH_ERROR_PATTERN.test(message) };
    }

    // An assistant message flagged with an API error (e.g. authentication_failed)
    // precedes the final result; only auth failures are treated as terminal here
    // (other API errors may be retried internally by the engine).
    if (event['type'] === 'assistant' && (typeof event['error'] === 'string' || event['isApiErrorMessage'] === true)) {
      const text = assistantText(event);
      const label = typeof event['error'] === 'string' ? event['error'] : '';
      if (AUTH_ERROR_PATTERN.test(`${label} ${text}`)) {
        return { message: text || label, retryable: false };
      }
    }
    return undefined;
  }

  parseResult(exitCode: number | null, stdout: string, stderr: string): EngineResult {
    const fallback: EngineResult = exitCode === null
      ? { status: 'failed', error: 'process exited without code' }
      : { status: exitCode === 0 ? 'success' : 'failed', exitCode };

    // The runner passes its bounded output tail. Its first or last line may
    // be incomplete after truncation, so only parse complete JSON objects.
    // Keep a line boundary between the streams: the retained result line has no
    // trailing newline, so plain concatenation would glue stderr onto it.
    const combined = stdout.length > 0 && stderr.length > 0 && !stdout.endsWith('\n')
      ? `${stdout}\n${stderr}` : stdout + stderr;
    for (const line of combined.split('\n').reverse()) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const result = value as Record<string, unknown>;
      if (result['type'] !== 'result') continue;

      const sessionId = typeof result['session_id'] === 'string' ? result['session_id'] : undefined;
      const costUsd = typeof result['total_cost_usd'] === 'number' && Number.isFinite(result['total_cost_usd'])
        ? result['total_cost_usd'] : undefined;
      const turns = typeof result['num_turns'] === 'number' && Number.isInteger(result['num_turns'])
        ? result['num_turns'] : undefined;
      const engineStatus = typeof result['subtype'] === 'string' ? result['subtype'] : undefined;
      const message = typeof result['result'] === 'string' && result['result'].length > 0
        ? result['result'] : undefined;
      const isError = result['is_error'] === true;

      return {
        ...fallback,
        status: exitCode === 0 && !isError ? 'success' : 'failed',
        ...(isError ? { error: message ?? engineStatus ?? 'Claude reported an error' } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(turns !== undefined ? { turns } : {}),
        ...('usage' in result ? { usage: result['usage'] } : {}),
        ...(engineStatus !== undefined ? { engineStatus } : {}),
      };
    }
    return fallback;
  }

  resolveSessionId(_opts: EngineOptions, result: EngineResult): string | undefined {
    return result.sessionId;
  }

  canCaptureSession(result: EngineResult): boolean {
    // parseResult only supplies an id after finding a complete result line.
    return this.resumableSessionId(result) !== undefined;
  }

  resumeTranscriptPath(cwd: string, sessionId: string, env?: NodeJS.ProcessEnv): string {
    return resolveTranscriptPath(cwd, sessionId, env ? { env } : {});
  }

  resumableSessionId(result: EngineResult): string | undefined {
    return result.sessionId;
  }
}

function assistantText(event: Record<string, unknown>): string {
  const message = event['message'];
  if (typeof message !== 'object' || message === null) return '';
  const content = (message as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (typeof block === 'object' && block !== null && (block as Record<string, unknown>)['type'] === 'text'
      ? String((block as Record<string, unknown>)['text'] ?? '') : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}
