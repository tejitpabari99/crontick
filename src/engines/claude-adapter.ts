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

  parseResult(exitCode: number | null): EngineResult {
    // Task 4 replaces this exit-code fallback with stream-json result parsing.
    if (exitCode === null) return { status: 'failed', error: 'process exited without code' };
    return { status: exitCode === 0 ? 'success' : 'failed', exitCode };
  }

  resolveSessionId(opts: EngineOptions, result: EngineResult): string | undefined {
    return result.sessionId ?? opts.sessionId;
  }
}
