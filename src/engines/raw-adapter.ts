import { EngineAdapter, type EngineInvocation, type EngineOptions, type EngineResult } from './types.js';

/** The original, engine-agnostic prompt CLI behavior. */
export class RawAdapter extends EngineAdapter {
  reservedArgs(): ReadonlySet<string> {
    return new Set(['-p', '--prompt', '--session-id', '-r', '--resume', '--continue', '--connect']);
  }

  buildInvocation(prompt: string, opts: EngineOptions): EngineInvocation {
    const args = [...opts.engineArgs, prompt, ...opts.args];
    if (opts.sessionId) args.push(`--session-id=${opts.sessionId}`);
    return { command: opts.command, args, env: { ...opts.env } };
  }

  parseResult(exitCode: number | null, stdout: string, stderr: string): EngineResult {
    if (exitCode === null) return { status: 'failed', error: 'process exited without code' };
    if (exitCode !== 0) return { status: 'failed', exitCode };
    const sessionId = extractSessionId(stdout + stderr);
    return sessionId
      ? { status: 'success', exitCode, sessionId }
      : { status: 'success', exitCode };
  }

  resolveSessionId(_opts: EngineOptions, result: EngineResult): string | undefined {
    return result.sessionId;
  }
}

/** Extract a generic session ID from the last 128 KB of combined engine output. */
export function extractSessionId(text: string): string | undefined {
  const patterns = [
    /--session-id[=\s]+([A-Za-z0-9][A-Za-z0-9._:-]{7,})/i,
    /(?:session\s*id|session-id|sessionId)\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._:-]{7,})/i,
    /(?:started|created|resum(?:e|ed|ing))\s+session\s+([A-Za-z0-9][A-Za-z0-9._:-]{7,})/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return undefined;
}
