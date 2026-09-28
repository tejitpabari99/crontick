import { randomUUID } from 'node:crypto';
import { EngineAdapter, type EngineInvocation, type EngineOptions, type EngineResult } from './types.js';

/** Claude Code's non-interactive stream-json invocation. */
export class ClaudeAdapter extends EngineAdapter {
  reservedArgs(): ReadonlySet<string> {
    return new Set(['-p', '--prompt', '--session-id', '-r', '--resume', '--continue', '--connect', '--output-format', '--settings']);
  }

  buildInvocation(prompt: string, opts: EngineOptions): EngineInvocation {
    const sessionId = opts.sessionId ?? randomUUID();
    return {
      command: opts.command,
      args: [
        ...opts.engineArgs,
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        ...(opts.sessionId ? ['--resume', sessionId] : ['--session-id', sessionId]),
        ...opts.args,
        // Task 12 replaces this neutral setting with the SessionEnd hook.
        '--settings', '{}',
      ],
      env: { ...opts.env },
      sessionId,
    };
  }

  parseResult(exitCode: number | null, stdout: string, stderr: string): EngineResult {
    const fallback: EngineResult = exitCode === null
      ? { status: 'failed', error: 'process exited without code' }
      : { status: exitCode === 0 ? 'success' : 'failed', exitCode };

    // The runner passes its bounded output tail. Its first or last line may
    // be incomplete after truncation, so only parse complete JSON objects.
    for (const line of (stdout + stderr).split('\n').reverse()) {
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

  resolveSessionId(opts: EngineOptions, result: EngineResult): string | undefined {
    return result.sessionId ?? opts.sessionId;
  }
}
