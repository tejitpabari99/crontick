/** Platform-neutral contracts between `AutostartService` and per-OS backends. */

/** Absolute-path description of what a backend registers. */
export interface AutostartSpec {
  nodePath: string;
  daemonScript: string;
  /** Absolute `dist/cli/index.js`; only used by backends that launch the CLI. */
  cliScript: string;
  env: Record<string, string>;
}

export interface AutostartExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Promise-based fs subset; injected so tests never touch the real filesystem. */
export interface AutostartFs {
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
  /** Resolves when the path exists, rejects otherwise. */
  access(path: string): Promise<void>;
}

export interface AutostartDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
  exec(file: string, args: string[]): Promise<AutostartExecResult>;
  fs: AutostartFs;
}

export interface BackendInspection {
  registered: boolean;
  enabledInManager?: boolean;
  active?: boolean;
  definitionPath?: string;
  command?: { nodePath: string; args: string[]; env: Record<string, string> };
  notes?: string[];
}

export type AutostartMechanism = 'systemd-user' | 'launchd' | 'schtasks';

export interface AutostartBackend {
  readonly mechanism: AutostartMechanism;
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Idempotent. */
  install(spec: AutostartSpec): Promise<{ definitionPath: string }>;
  /** Idempotent. */
  uninstall(): Promise<{ removed: boolean }>;
  /** Read-only; "not registered" is a value, not a throw. */
  inspect(): Promise<BackendInspection>;
  /** What drift compares `inspect().command.args` against; default `[spec.daemonScript]`. */
  expectedCommand?(spec: AutostartSpec): string[];
}

export interface AutostartStatus {
  supported: boolean;
  enabled: boolean;
  mechanism?: string;
  definitionPath?: string;
  /** Human-readable registered command line. */
  command?: string;
  active?: boolean;
  stale: boolean;
  staleReasons: string[];
  reason?: string;
  hints: string[];
}

export interface AutostartEnableResult {
  enabled: true;
  mechanism: string;
  definitionPath: string;
  hints: string[];
}

export interface AutostartDisableResult {
  removed: boolean;
  mechanism?: string;
}
