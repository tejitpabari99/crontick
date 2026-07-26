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
import { buildPromptRunCommand, loadConfig } from '../config.js';
import { nullLogger, redactText, type Logger } from '../logger.js';
import { isProcessAlive } from '../process-liveness.js';

// ── Output cap (L5) ───────────────────────────────────────────────────────────

/**
 * Default bytes captured per run before further stdout/stderr is dropped
 * (mirrors the design's `retention.maxOutputBytesPerRun`). This is the
 * daemon-side default until that config key lands; see resolveMaxOutputBytesPerRun().
 *
 * Expected config shape once added by the surface agent (src/schemas/config.ts):
 *   retention.maxOutputBytesPerRun: number (int, min 1024, max 1_000_000_000, default 2_000_000)
 * Read defensively below since the key doesn't exist on RetentionConfig yet.
 */
export const DEFAULT_MAX_OUTPUT_BYTES_PER_RUN = 2_000_000;

/** Marker line appended exactly once when a run's captured output hits the cap. */
export function truncationMarker(maxBytes: number): string {
  return `\n[crontick] output truncated: exceeded ${maxBytes} bytes (retention.maxOutputBytesPerRun); further output from this run is not stored\n`;
}

/** Reads retention.maxOutputBytesPerRun defensively — the key may not exist on the schema yet. */
function resolveMaxOutputBytesPerRun(): number {
  try {
    const retention = loadConfig().retention as unknown as Record<string, unknown>;
    const raw = retention['maxOutputBytesPerRun'];
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
      ? raw
      : DEFAULT_MAX_OUTPUT_BYTES_PER_RUN;
  } catch {
    return DEFAULT_MAX_OUTPUT_BYTES_PER_RUN;
  }
}

// ── Adopted-run polling (L3/L4) ────────────────────────────────────────────────

/** How often an adopted run's pid is polled for liveness (see Runner.adoptRun()). */
const ADOPTED_RUN_POLL_MS = 3_000;

/**
 * Sentinel error recorded on an adopted run once its process is observed to
 * have exited on its own (not via our SIGTERM) while the daemon was down or
 * busy starting up. Distinct from ORPHAN_RUN_ERROR_MESSAGE (src/errors.ts),
 * which means "this run was still alive/unknown and we canceled it" — this
 * one means "it already finished, but without a daemon around to capture the
 * exit code."
 */
export const ADOPTED_RUN_EXITED_MESSAGE =
  'DAEMON_RESTART: process exited while the daemon was not running or between adoption and this check; exit code unknown';

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
  /** Poll timers for adopted runs (see adoptRun()), keyed by runId so they can be cleared. */
  private adoptedPolls: Map<string, ReturnType<typeof setInterval>> = new Map();

  private readonly logger: Logger;

  constructor(
    private readonly spawnFn: typeof spawn = spawn,
    logger: Logger = nullLogger,
    private readonly maxOutputBytesPerRunOverride?: number,
    /** Test-only seam: overrides ADOPTED_RUN_POLL_MS so adoptRun() tests don't wait 3s per poll tick. */
    private readonly adoptedPollMsOverride?: number,
  ) {
    this.logger = logger.child('runner');
  }

  /**
   * Re-attach in-memory overlap tracking (L3) to a run the store's
   * reconcileOrphanRuns() confirmed (or couldn't rule out) is still alive
   * from a previous daemon session (L4). This restores `overlap: skip` (the
   * job is seen as active) and `overlap: cancel-previous` (abort() best-
   * effort SIGTERMs the real pid, since there is no in-process ChildProcess
   * handle for it) across a restart.
   *
   * A lightweight poll detects the adopted process exiting on its own so the
   * job doesn't stay "active" forever in this daemon's memory — without it,
   * overlap=skip would permanently skip every future tick for this job until
   * the next full daemon restart, which would be a worse regression than the
   * orphan-cancel behavior this replaces.
   */
  adoptRun(jobId: string, runId: string, pid: number, store: Store): void {
    this.activeRunIds.set(jobId, runId);

    const ctrl = new AbortController();
    let canceledByAbort = false;
    ctrl.signal.addEventListener('abort', () => {
      canceledByAbort = true;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    });
    this.activeAborts.set(jobId, ctrl);

    const poll = setInterval(() => {
      if (isProcessAlive(pid)) return;
      clearInterval(poll);
      this.adoptedPolls.delete(runId);
      if (this.activeAborts.get(jobId) === ctrl) this.activeAborts.delete(jobId);
      if (this.activeRunIds.get(jobId) === runId) this.activeRunIds.delete(jobId);
      try {
        const run = store.getRun(runId);
        if (run && run.status === 'running') {
          store.updateRun(runId, {
            status: 'canceled',
            error: canceledByAbort ? 'DAEMON_RESTART: adopted run was terminated' : ADOPTED_RUN_EXITED_MESSAGE,
            endedAt: Date.now(),
          });
        }
      } catch (err) {
        this.logger.error('Failed to finalize adopted run after exit', { jobId, runId, error: String(err) });
      }
    }, this.adoptedPollMsOverride ?? ADOPTED_RUN_POLL_MS);
    poll.unref?.();
    this.adoptedPolls.set(runId, poll);
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
      // detached + windowsHide (L8): children survive the daemon's death uniformly on
      // both platforms — POSIX reparents to init (unchanged from before), and on
      // Windows CREATE_NEW_PROCESS_GROUP decouples the child from the daemon's Job
      // Object so it isn't torn down when the daemon exits/crashes/restarts.
      // windowsHide prevents a visible console window from appearing for every job
      // on Windows now that detached is always set (Node opens one by default
      // otherwise). Combined with L3/L4's pid-based adoption, a child that's still
      // alive when the daemon comes back up is re-attached instead of double-run.
      const spawnOpts: Parameters<typeof spawn>[2] = {
        cwd: action.cwd ?? process.cwd(),
        env: { ...process.env, ...promptEnv, ...(action.env ?? {}) } as NodeJS.ProcessEnv,
        signal,
        shell: false,
        detached: true,
        windowsHide: true,
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

      // Byte cap on captured output (L5): re-read per run (not cached at Runner
      // construction) so a config change via `crontick daemon reload` takes
      // effect for new runs without a full restart, mirroring the
      // maxRunsPerJob reload pattern. The child process itself is never
      // killed or throttled here — only persistence of further chunks stops.
      const maxOutputBytes = this.maxOutputBytesPerRunOverride ?? resolveMaxOutputBytesPerRun();
      let capturedBytes = 0;
      let outputTruncated = false;
      const captureChunk = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
        if (outputTruncated) return; // marker already emitted; drop silently, child keeps running
        if (capturedBytes + chunk.length > maxOutputBytes) {
          const room = Math.max(0, maxOutputBytes - capturedBytes);
          if (room > 0) store.appendLog(runId, stream, safeRedact(chunk.subarray(0, room)));
          store.appendLog(runId, stream, Buffer.from(truncationMarker(maxOutputBytes), 'utf-8'));
          try {
            store.updateRun(runId, { outputTruncated: true });
          } catch (err) {
            this.logger.error('Failed to persist outputTruncated flag', { jobId: job.id, runId, error: String(err) });
          }
          outputTruncated = true;
          return;
        }
        capturedBytes += chunk.length;
        store.appendLog(runId, stream, safeRedact(chunk));
      };

      const result = await new Promise<RunResult>((resolve) => {
        this.logger.debug('Spawning child process', { jobId: job.id, runId, command: cmd, args, cwd: spawnOpts.cwd, timeoutMs: spawnOpts.timeout });
        this.appendDiagnosticLog(store, runId, 'spawn', { command: cmd, args, cwd: spawnOpts.cwd, timeoutMs: spawnOpts.timeout });
        const child = this.spawnFn(cmd, args, spawnOpts);
        // Persist the OS pid the instant it's known (L4) — nothing before this
        // point could reconcile against it. unref() so a detached child never
        // keeps the daemon's event loop alive on its own.
        if (child.pid !== undefined) {
          try {
            store.updateRun(runId, { pid: child.pid });
          } catch (err) {
            this.logger.error('Failed to persist run pid', { jobId: job.id, runId, error: String(err) });
          }
        }
        child.unref?.();
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
            captureChunk('stdout', chunk);
          } catch (err) {
            failFromCallback(err);
          }
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          try {
            appendTranscript(chunk);
            captureChunk('stderr', chunk);
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
