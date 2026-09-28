import { randomUUID } from 'node:crypto';
import { claudeCompletionMarkerPath } from '../claude-completion-marker.js';
import { EngineAdapter, type EngineInvocation, type EngineOptions, type EngineResult } from './types.js';
import { resolveTranscriptPath } from './claude-transcript.js';

/** Claude Code's non-interactive stream-json invocation. */
export class ClaudeAdapter extends EngineAdapter {
  reservedArgs(): ReadonlySet<string> {
    return new Set(['-p', '--prompt', '--session-id', '-r', '--resume', '--continue', '--connect', '--output-format', '--settings']);
  }

  buildInvocation(prompt: string, opts: EngineOptions): EngineInvocation {
    const sessionId = opts.sessionId ?? randomUUID();
    // Internal command previews may omit run context; only an actual runner
    // supplies the stable run ID that restart reconciliation can look up.
    const markerPath = claudeCompletionMarkerPath(opts.dataDir || '.', opts.runId || randomUUID());
    // Claude runs command hooks through the platform shell. Base64 keeps paths
    // and user-controlled data out of shell syntax; the hook itself uses only
    // Node platform APIs and writes a private file. It never edits user settings.
    const script = `try {
      const fs = require('node:fs');
      const path = require('node:path');
      const markerPath = ${JSON.stringify(markerPath)};
      const input = JSON.parse(fs.readFileSync(0, 'utf8'));
      const raw = input.exit_status ?? input.exitStatus ?? input.exit_code ?? input.exitCode ?? null;
      const exitStatus = Number.isInteger(raw) && raw >= 0 && raw <= 255 ? raw : null;
      const sessionId = typeof input.session_id === 'string' ? input.session_id :
        (typeof input.sessionId === 'string' ? input.sessionId : null);
      fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(markerPath, JSON.stringify({ exitStatus, sessionId }), { mode: 0o600 });
    } catch { /* A best-effort hook must not change Claude's outcome. */ }`;
    const encoded = Buffer.from(script, 'utf8').toString('base64');
    const nodeCommand = process.platform === 'win32'
      ? `"${process.execPath}"`
      : `'${process.execPath.replaceAll("'", "'\\''")}'`;
    const settings = JSON.stringify({
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: `${nodeCommand} -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"` }] }] },
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
        '--settings', settings,
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

  resolveSessionId(_opts: EngineOptions, result: EngineResult): string | undefined {
    return result.sessionId;
  }

  canCaptureSession(result: EngineResult): boolean {
    // parseResult only supplies an id after finding a complete result line.
    return this.resumableSessionId(result) !== undefined;
  }

  resumeTranscriptPath(cwd: string, sessionId: string): string {
    return resolveTranscriptPath(cwd, sessionId);
  }

  resumableSessionId(result: EngineResult): string | undefined {
    return result.sessionId;
  }
}
