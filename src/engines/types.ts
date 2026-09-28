/** Shared inputs and outputs for engine-specific prompt execution. */
export interface EngineOptions {
  command: string;
  engineArgs: string[];
  runId: string;
  jobId: string;
  dataDir: string;
  sessionId?: string;
  reuseSession: boolean;
  args: string[];
  env: Record<string, string>;
}

export interface EngineInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Session selected before spawn; the runner persists it as soon as the child exists. */
  sessionId?: string;
}

export interface EngineResult {
  status: 'success' | 'failed';
  exitCode?: number;
  error?: string;
  sessionId?: string;
  costUsd?: number;
  turns?: number;
  usage?: unknown;
  engineStatus?: string;
}

export abstract class EngineAdapter {
  abstract reservedArgs(): ReadonlySet<string>;
  abstract buildInvocation(prompt: string, opts: EngineOptions): EngineInvocation;
  abstract parseResult(exitCode: number | null, stdout: string, stderr: string): EngineResult;
  abstract resolveSessionId(opts: EngineOptions, result: EngineResult): string | undefined;

  /** Raw engines retain their original success-only session capture rule. */
  canCaptureSession(result: EngineResult): boolean {
    return result.status === 'success';
  }

  /** Only adapters with transcript-backed resume return a path to preflight. */
  resumeTranscriptPath(cwd: string, sessionId: string): string | undefined {
    void cwd;
    void sessionId;
    return undefined;
  }

  /** A completed result whose session may become an eligible resume target. */
  resumableSessionId(result: EngineResult): string | undefined {
    void result;
    return undefined;
  }
}
