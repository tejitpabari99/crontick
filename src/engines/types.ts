/** Shared inputs and outputs for engine-specific prompt execution. */
export interface EngineOptions {
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
}
