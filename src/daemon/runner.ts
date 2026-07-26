// Job execution engine: spawns child processes, enforces overlap policies,
// retry with backoff, timeout, and stream capture with secret redaction.
// See docs/internals/executors.md
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job, PromptAction } from '../schemas/job.js';
import type { Store, RunStatus } from './store.js';
import { CrontickError } from '../errors.js';
import { extractSessionId } from './prompt-session.js';
import { buildPromptRunCommand } from '../config.js';
import { nullLogger, redactText, type Logger } from '../logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RunResult {
  status: RunStatus;
  exitCode?: number;
  error?: string;
}

type QueueEntry = () => Promise<void>;

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
  const cleaned = redactText(str);
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
  /** Per-job FIFO queues for overlap='queue' policy */
  private queues: Map<string, QueueEntry[]> = new Map();
  /** AbortControllers for the currently active run per job (overlap enforcement) */
  private activeAborts: Map<string, AbortController> = new Map();
  /** Maps job ID → active run ID (used by cancelRun to locate the right controller) */
  private activeRunIds: Map<string, string> = new Map();
  /** Tracks which job queues are currently being drained */
  private draining: Set<string> = new Set();

  private readonly logger: Logger;

  constructor(private readonly spawnFn: typeof spawn = spawn, logger: Logger = nullLogger) {
    this.logger = logger.child('runner');
  }

  /**
   * Execute a job run, honouring overlap + retry policies.
   * The run record must already exist in the store (status=queued).
   */
  async run(job: Job, runId: string, store: Store): Promise<void> {
    const overlap = job.overlap ?? 'skip';
    this.logger.debug('Starting run orchestration', { jobId: job.id, runId, overlap, retryMax: job.retry?.max ?? 0 });
    this.appendDiagnosticLog(store, runId, 'run orchestration', { jobId: job.id, overlap, retryMax: job.retry?.max ?? 0 });

    const isActive = this.activeRunIds.has(job.id);

    if (overlap === 'skip' && isActive) {
      await this.finalizeRun(store, runId, {
        status: 'canceled',
        error: 'overlap=skip: another run is already active',
      });
      this.logger.debug('Canceled run due to overlap=skip', { jobId: job.id, runId });
      return;
    }

    if (overlap === 'cancel-previous' && isActive) {
      const ctrl = this.activeAborts.get(job.id);
      if (ctrl) ctrl.abort();
      this.logger.debug('Canceled previous active run for job', { jobId: job.id, runId });
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
      this.logger.debug('Queued run for overlap policy', { jobId: job.id, runId, queueLength: queue.length });
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
          this.logger.debug('Retry backoff before run attempt', { jobId: job.id, runId, attempt, backoffSec });
          this.appendDiagnosticLog(store, runId, 'retry backoff', { attempt, backoffSec });
          await sleep(backoffSec * 1000);
        }
        // Check abort before each retry attempt (cancel-previous or manual cancel)
        if (ctrl.signal.aborted) {
          lastResult = { status: 'canceled', error: 'canceled before retry' };
          break;
        }
        lastResult = await this.spawn(job, runId, store, ctrl.signal);
        this.logger.debug('Run attempt completed', { jobId: job.id, runId, attempt, status: lastResult.status, exitCode: lastResult.exitCode });
        this.appendDiagnosticLog(store, runId, 'attempt completed', { attempt, status: lastResult.status, exitCode: lastResult.exitCode });
        if (lastResult.status === 'success') break;
        if (lastResult.status === 'canceled' || lastResult.status === 'timeout') break;
      }
    } finally {
      // Only clear if these maps still point to THIS run's state. A newer run
      // via cancel-previous may have already overwritten them.
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

      let capturePromptSession = false;
      let promptCaptureAction: PromptAction | undefined;
      let promptSessionJob = job;
      let promptEngineBinary: string | undefined;
      let promptEnv: Record<string, string> = {};

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
      } else if (action.kind === 'exec') {
        cmd = action.command;
        args = action.args ?? [];
      } else {
        const latestJob = store.getJob(job.id);
        if (latestJob?.action.kind === 'prompt') promptSessionJob = latestJob;
        const latestAction =
          promptSessionJob.action.kind === 'prompt' ? promptSessionJob.action : action;
        const sessionId = latestAction.sessionId ?? action.sessionId;
        capturePromptSession = latestAction.reuseSession && !sessionId;
        promptCaptureAction = capturePromptSession ? latestAction : undefined;
        if (sessionId && latestAction.reuseSession) {
          store.appendLog(
            runId,
            'stderr',
            Buffer.from('[crontick] notice: reuseSession was ignored because an explicit sessionId was provided.\n', 'utf-8'),
          );
        }

        const runCommand = buildPromptRunCommand({ ...latestAction, sessionId }, { logger: this.logger });
        cmd = runCommand.command;
        promptEngineBinary = runCommand.engine;
        args = runCommand.args;
        promptEnv = runCommand.env;
        this.logger.debug('Resolved prompt run command', { jobId: job.id, runId, engine: promptEngineBinary, command: cmd, args, envKeys: Object.keys(promptEnv) });
        this.appendDiagnosticLog(store, runId, 'resolved prompt command', { engine: promptEngineBinary, command: cmd, args, envKeys: Object.keys(promptEnv) });
      }

      // All action kinds use shell:false — no shell interpretation, preventing injection.
      const spawnOpts: Parameters<typeof spawn>[2] = {
        cwd: action.cwd ?? process.cwd(),
        env: { ...process.env, ...promptEnv, ...(action.env ?? {}) } as NodeJS.ProcessEnv,
        signal,
        shell: false,
      };

      // Merge envFile variables (lower priority than action.env, higher than process.env).
      if (action.envFile) {
        const envFilePath = isAbsolute(action.envFile)
          ? action.envFile
          : join(action.cwd ?? process.cwd(), action.envFile);
        try {
          const fileContents = readFileSync(envFilePath, 'utf-8');
          const envFileVars = parseEnvFile(fileContents);
          spawnOpts.env = {
            ...process.env,
            ...promptEnv,
            ...envFileVars,
            ...(action.env ?? {}),
          } as NodeJS.ProcessEnv;
          this.logger.debug('Loaded env file for run', { jobId: job.id, runId, envFile: envFilePath, envKeys: Object.keys(envFileVars) });
        } catch (err) {
          throw new CrontickError('ENV_FILE_ERROR', `Failed to load envFile: ${String(err)}`);
        }
      }

      // Timeout enforcement: passed as ms to spawn; Node emits ETIMEDOUT on expiry.
      if (action.timeoutSec) {
        spawnOpts.timeout = action.timeoutSec * 1000;
      }

      // Ring buffer for prompt session ID extraction (max 128 KB of combined output).
      const maxTranscriptBytes = 128 * 1024;
      let transcriptTail = Buffer.alloc(0);
      const appendTranscript = (chunk: Buffer) => {
        if (!capturePromptSession) return;
        transcriptTail = Buffer.concat([transcriptTail, chunk]);
        if (transcriptTail.byteLength > maxTranscriptBytes) {
          transcriptTail = transcriptTail.subarray(transcriptTail.byteLength - maxTranscriptBytes);
        }
      };

      const result = await new Promise<RunResult>((resolve) => {
        this.logger.debug('Spawning child process', { jobId: job.id, runId, command: cmd, args, cwd: spawnOpts.cwd, timeoutMs: spawnOpts.timeout });
        this.appendDiagnosticLog(store, runId, 'spawn', { command: cmd, args, cwd: spawnOpts.cwd, timeoutMs: spawnOpts.timeout });
        const child = this.spawnFn(cmd, args, spawnOpts);
        const startedAt = Date.now();
        const captureAction = promptCaptureAction;
        let settled = false;
        const finish = (runResult: RunResult) => {
          if (settled) return;
          settled = true;
          resolve(runResult);
        };
        const failFromCallback = (err: unknown) => {
          finish({ status: 'failed', error: `RUNNER_CALLBACK_FAILED: ${errorMessage(err)}` });
          try {
            if (!signal.aborted) child.kill('SIGTERM');
          } catch {
            // ignore termination races
          }
        };

        child.stdout?.on('data', (chunk: Buffer) => {
          try {
            appendTranscript(chunk);
            store.appendLog(runId, 'stdout', safeRedact(chunk));
          } catch (err) {
            failFromCallback(err);
          }
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          try {
            appendTranscript(chunk);
            store.appendLog(runId, 'stderr', safeRedact(chunk));
          } catch (err) {
            failFromCallback(err);
          }
        });

        child.on('close', (code, sig) => {
          const durationMs = Date.now() - startedAt;
          this.logger.debug('Child process closed', { jobId: job.id, runId, code, signal: sig, durationMs });
          this.appendDiagnosticLog(store, runId, 'child closed', { code, signal: sig, durationMs });
          if (signal.aborted) {
            finish({ status: 'canceled', error: 'aborted' });
          } else if (sig === 'SIGTERM' || sig === 'SIGKILL') {
            finish({ status: 'canceled', error: `killed by signal ${sig}` });
          } else if (code === null) {
            finish({ status: 'failed', error: 'process exited without code' });
          } else {
            const result: RunResult = {
              status: code === 0 ? 'success' : 'failed',
              exitCode: code,
            };
            if (result.status === 'success' && capturePromptSession) {
              const sessionId = extractSessionId(transcriptTail.toString('utf-8'));
              if (!sessionId) {
                this.logger.debug('Session id capture failed', { jobId: job.id, runId });
                finish({
                  status: 'failed',
                  exitCode: code,
                  error: 'SESSION_ID_NOT_FOUND: prompt engine output did not include a session id. Configure an explicit session id with --session-id <id>, or disable reuseSession.',
                });
                return;
              }
              if (captureAction) {
                let persisted = false;
                try {
                  persisted = store.tryCapturePromptSession(job.id, captureAction, sessionId);
                } catch (err) {
                  finish({
                    status: 'failed',
                    exitCode: code,
                    error: `SESSION_PERSIST_FAILED: ${errorMessage(err)}`,
                  });
                  return;
                }
                if (persisted) {
                  this.logger.debug('Session id captured and persisted', { jobId: job.id, runId });
                  try {
                    store.appendLog(runId, 'stdout', Buffer.from(`[crontick] captured session id: ${sessionId}\n`, 'utf-8'));
                  } catch (err) {
                    finish({
                      status: 'failed',
                      exitCode: code,
                      error: `SESSION_PERSIST_FAILED: ${errorMessage(err)}`,
                    });
                    return;
                  }
                }
              }
            }
            finish(result);
          }
          void durationMs; // consumed below via store
        });

        child.on('error', (err: NodeJS.ErrnoException) => {
          this.logger.debug('Child process error', { jobId: job.id, runId, code: err.code, message: err.message });
          this.appendDiagnosticLog(store, runId, 'child error', { code: err.code, message: err.message });
          if (err.code === 'ABORT_ERR' || signal.aborted) {
            finish({ status: 'canceled', error: 'aborted' });
          } else if (err.code === 'ETIMEDOUT') {
            finish({ status: 'timeout', error: 'timed out' });
          } else if (err.code === 'ENOENT' && promptEngineBinary) {
            finish({
              status: 'failed',
              error: `Prompt engine "${promptEngineBinary}" command "${cmd}" was not found on PATH. Install it, update PATH, or change engines.${promptEngineBinary}.command in crontick config before the next run.`,
            });
          } else {
            finish({ status: 'failed', error: err.message });
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
    this.logger.debug('Finalized run', { runId, status: result.status, exitCode: result.exitCode, durationMs: run ? now - run.startedAt : undefined });
  }

  private appendDiagnosticLog(store: Store, runId: string, message: string, data?: unknown): void {
    if (!this.logger.isDebugEnabled()) return;
    const suffix = data === undefined ? '' : ` ${redactText(JSON.stringify(data))}`;
    store.appendLog(runId, 'stderr', Buffer.from(`[crontick:debug] ${message}${suffix}\n`, 'utf-8'));
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

/** Resolve shell per platform: 'auto' → pwsh on Windows, bash elsewhere. */
function resolveShell(shell: string): 'bash' | 'pwsh' | 'cmd' {
  if (shell === 'auto') {
    return platform() === 'win32' ? 'pwsh' : 'bash';
  }
  if (shell === 'pwsh') return 'pwsh';
  if (shell === 'cmd') return 'cmd';
  return 'bash';
}

/** Map shell name to temp-file extension (.ps1, .bat, .sh). */
function resolveShellExt(shell: string): string {
  const resolved = resolveShell(shell);
  if (resolved === 'pwsh') return '.ps1';
  if (resolved === 'cmd') return '.bat';
  return '.sh';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
