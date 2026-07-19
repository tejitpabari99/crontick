import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job } from '../schemas/job.js';
import type { Store, RunStatus } from './store.js';
import { CrontickError } from '../errors.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RunResult {
  status: RunStatus;
  exitCode?: number;
  error?: string;
}

type QueueEntry = () => Promise<void>;

// ── Secret redaction ──────────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  /(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)=[^\s]*/gi,
  /(?:GITHUB_TOKEN|GH_TOKEN)=[^\s]*/gi,
  /(?:GCLOUD_SERVICE_KEY|GOOGLE_CREDENTIALS)=[^\s]*/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /ghp_[A-Za-z0-9]{36}/g,
  /AKIA[0-9A-Z]{16}/g,
];

function redact(text: string): string {
  let out = text;
  for (const pat of SECRET_PATTERNS) {
    out = out.replace(pat, '[REDACTED]');
  }
  return out;
}

/**
 * Redact secrets from a chunk only when it is valid UTF-8 text.
 * Binary data (NUL bytes or lossy UTF-8 round-trip) is stored as-is.
 */
function safeRedact(chunk: Buffer): Buffer {
  // NUL byte → likely binary, skip redaction
  if (chunk.includes(0)) return chunk;
  const str = chunk.toString('utf8');
  // Lossy round-trip → binary or non-UTF-8, skip redaction
  if (!Buffer.from(str, 'utf8').equals(chunk)) return chunk;
  const cleaned = redact(str);
  return Buffer.from(cleaned, 'utf8');
}

// ── Env-file loader ───────────────────────────────────────────────────────────

/**
 * Parse a .env-style file (KEY=VALUE, # comments, quoted values).
 * Returns a record of KEY → VALUE.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export class Runner {
  /** Per-job queues for overlap=queue policy */
  private queues: Map<string, QueueEntry[]> = new Map();
  /** Abort controllers for currently active runs per job */
  private activeAborts: Map<string, AbortController> = new Map();
  /** Active run IDs per job */
  private activeRunIds: Map<string, string> = new Map();
  /** Whether a job's queue is currently being drained */
  private draining: Set<string> = new Set();

  /**
   * Execute a job run, honouring overlap + retry + budget policies.
   * The run record must already exist in the store (status=queued).
   */
  async run(job: Job, runId: string, store: Store): Promise<void> {
    const overlap = job.overlap ?? 'skip';

    // Budget: maxRunsPerDay
    if (job.budgets?.maxRunsPerDay != null) {
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const count = store.countRunsSince(job.id, todayStart.getTime(), runId);
      if (count >= job.budgets.maxRunsPerDay) {
        await this.finalizeRun(store, runId, {
          status: 'canceled',
          error: `budget: maxRunsPerDay (${job.budgets.maxRunsPerDay}) exceeded`,
        });
        return;
      }
    }

    const isActive = this.activeRunIds.has(job.id);

    if (overlap === 'skip' && isActive) {
      await this.finalizeRun(store, runId, {
        status: 'canceled',
        error: 'overlap=skip: another run is already active',
      });
      return;
    }

    if (overlap === 'cancel-previous' && isActive) {
      const ctrl = this.activeAborts.get(job.id);
      if (ctrl) ctrl.abort();
    }

    if (overlap === 'queue') {
      await this.enqueue(job, runId, store);
    } else {
      await this.execute(job, runId, store);
    }
  }

  private enqueue(job: Job, runId: string, store: Store): Promise<void> {
    return new Promise<void>((resolve) => {
      const queue = this.queues.get(job.id) ?? [];
      queue.push(async () => {
        await this.execute(job, runId, store);
        resolve();
      });
      this.queues.set(job.id, queue);
      if (!this.draining.has(job.id)) {
        this.drainQueue(job.id);
      }
    });
  }

  private async drainQueue(jobId: string): Promise<void> {
    this.draining.add(jobId);
    const queue = this.queues.get(jobId);
    if (!queue || queue.length === 0) {
      this.draining.delete(jobId);
      return;
    }
    const next = queue.shift()!;
    try {
      await next();
    } catch {
      // errors handled inside execute
    }
    await this.drainQueue(jobId);
  }

  private async execute(job: Job, runId: string, store: Store): Promise<void> {
    const maxRetries = job.retry?.max ?? 0;
    const backoffSec = job.retry?.backoffSec ?? 30;
    let lastResult: RunResult = { status: 'failed', error: 'not started' };

    store.updateRun(runId, { status: 'running' });

    const ctrl = new AbortController();
    this.activeAborts.set(job.id, ctrl);
    this.activeRunIds.set(job.id, runId);

    try {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          await sleep(backoffSec * 1000);
        }
        if (ctrl.signal.aborted) {
          lastResult = { status: 'canceled', error: 'canceled before retry' };
          break;
        }
        lastResult = await this.spawn(job, runId, store, ctrl.signal);
        if (lastResult.status === 'success') break;
        if (lastResult.status === 'canceled' || lastResult.status === 'timeout') break;
      }
    } finally {
      // Only delete if these maps still point to THIS run's ctrl/runId.
      // A newer run (cancel-previous) may have already overwritten them.
      if (this.activeAborts.get(job.id) === ctrl) this.activeAborts.delete(job.id);
      if (this.activeRunIds.get(job.id) === runId) this.activeRunIds.delete(job.id);
    }

    await this.finalizeRun(store, runId, lastResult);
  }

  private async spawn(
    job: Job,
    runId: string,
    store: Store,
    signal: AbortSignal,
  ): Promise<RunResult> {
    const { action } = job;
    let tmpFile: string | undefined;

    try {
      let cmd: string;
      let args: string[];

      if (action.kind === 'script') {
        // Write script to temp file
        const ext = resolveShellExt(action.shell ?? 'auto');
        const tmpDir = join(tmpdir(), 'crontick');
        mkdirSync(tmpDir, { recursive: true });
        tmpFile = join(tmpDir, `${randomUUID()}${ext}`);
        writeFileSync(tmpFile, action.script, { encoding: 'utf-8', mode: 0o700 });

        const resolved = resolveShell(action.shell ?? 'auto');
        if (resolved === 'pwsh') {
          cmd = 'pwsh';
          args = ['-NoProfile', '-NonInteractive', '-File', tmpFile];
        } else if (resolved === 'cmd') {
          cmd = 'cmd';
          args = ['/c', tmpFile];
        } else {
          cmd = 'bash';
          args = [tmpFile];
        }
      } else {
        cmd = action.command;
        args = action.args ?? [];
      }

      const spawnOpts: Parameters<typeof spawn>[2] = {
        cwd: action.cwd ?? process.cwd(),
        env: { ...process.env, ...(action.env ?? {}) } as NodeJS.ProcessEnv,
        signal,
        shell: false,
      };

      // Merge envFile variables (lower priority than action.env).
      // We intentionally do not log environment snapshots, so secret-shaped
      // env-file values are not emitted to logs.
      if (action.envFile) {
        const envFilePath = isAbsolute(action.envFile)
          ? action.envFile
          : join(action.cwd ?? process.cwd(), action.envFile);
        try {
          const fileContents = readFileSync(envFilePath, 'utf-8');
          const envFileVars = parseEnvFile(fileContents);
          spawnOpts.env = {
            ...process.env,
            ...envFileVars,
            ...(action.env ?? {}),
          } as NodeJS.ProcessEnv;
        } catch (err) {
          throw new CrontickError('ENV_FILE_ERROR', `Failed to load envFile: ${String(err)}`);
        }
      }

      if (action.timeoutSec) {
        spawnOpts.timeout = action.timeoutSec * 1000;
      }

      const result = await new Promise<RunResult>((resolve) => {
        const child = spawn(cmd, args, spawnOpts);
        const startedAt = Date.now();

        child.stdout?.on('data', (chunk: Buffer) => {
          store.appendLog(runId, 'stdout', safeRedact(chunk));
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          store.appendLog(runId, 'stderr', safeRedact(chunk));
        });

        child.on('close', (code, sig) => {
          const durationMs = Date.now() - startedAt;
          if (sig === 'SIGTERM' || sig === 'SIGKILL') {
            resolve({ status: 'canceled', error: `killed by signal ${sig}` });
          } else if (code === null) {
            resolve({ status: 'failed', error: 'process exited without code' });
          } else {
            resolve({
              status: code === 0 ? 'success' : 'failed',
              exitCode: code,
            });
          }
          void durationMs; // consumed below via store
        });

        child.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ABORT_ERR' || signal.aborted) {
            resolve({ status: 'canceled', error: 'aborted' });
          } else if (err.code === 'ETIMEDOUT') {
            resolve({ status: 'timeout', error: 'timed out' });
          } else {
            resolve({ status: 'failed', error: err.message });
          }
        });
      });

      return result;
    } finally {
      if (tmpFile && existsSync(tmpFile)) {
        try {
          unlinkSync(tmpFile);
        } catch {
          // ignore cleanup failure
        }
      }
    }
  }

  private async finalizeRun(store: Store, runId: string, result: RunResult): Promise<void> {
    const run = store.getRun(runId);
    const now = Date.now();
    store.updateRun(runId, {
      status: result.status,
      exitCode: result.exitCode,
      error: result.error,
      endedAt: now,
      durationMs: run ? now - run.startedAt : undefined,
    });
  }

  /** Cancel any active run for a job. */
  cancelJob(jobId: string): boolean {
    const ctrl = this.activeAborts.get(jobId);
    if (ctrl) {
      ctrl.abort();
      return true;
    }
    return false;
  }

  /** Cancel an active run by run ID. */
  cancelRun(runId: string): boolean {
    for (const [jobId, rId] of this.activeRunIds.entries()) {
      if (rId === runId) {
        return this.cancelJob(jobId);
      }
    }
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveShell(shell: string): 'bash' | 'pwsh' | 'cmd' {
  if (shell === 'auto') {
    return platform() === 'win32' ? 'pwsh' : 'bash';
  }
  if (shell === 'pwsh') return 'pwsh';
  if (shell === 'cmd') return 'cmd';
  return 'bash';
}

function resolveShellExt(shell: string): string {
  const resolved = resolveShell(shell);
  if (resolved === 'pwsh') return '.ps1';
  if (resolved === 'cmd') return '.bat';
  return '.sh';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { CrontickError };
