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

/**
 * A failure the engine has already reported in its output stream. Once seen, the
 * outcome of the run is decided: the runner gives the process a short grace period
 * to exit on its own, then terminates it, so a wedged engine cannot hold the run
 * (and, with overlap=skip, every later tick) hostage.
 */
export interface TerminalEngineError {
  message: string;
  /** False for failures a retry cannot fix (for example authentication). */
  retryable: boolean;
}

export interface FolderTrustContext {
  env?: NodeJS.ProcessEnv;
}

export abstract class EngineAdapter {
  abstract reservedArgs(): ReadonlySet<string>;
  abstract buildInvocation(prompt: string, opts: EngineOptions): EngineInvocation;
  abstract parseResult(exitCode: number | null, stdout: string, stderr: string): EngineResult;
  abstract resolveSessionId(opts: EngineOptions, result: EngineResult): string | undefined;

  /** Inspect one complete stdout line while the run is live. Adapters without a structured stream return undefined. */
  detectTerminalError(line: string): TerminalEngineError | undefined {
    void line;
    return undefined;
  }

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

  /**
   * Optional folder-trust hooks. Only engines that gate project folders behind
   * a trust decision (Claude) implement them; engines without them skip the
   * trust check entirely. `ctx.env` lets callers redirect the engine's config
   * location (tests, `CLAUDE_CONFIG_DIR`).
   */
  isFolderTrusted?(cwd: string, ctx?: FolderTrustContext): boolean;
  /** Persist the user's consent to trust `cwd`. May throw CrontickError (e.g. CLAUDE_CONFIG_UNREADABLE). */
  trustFolder?(cwd: string, ctx?: FolderTrustContext): void;
}
