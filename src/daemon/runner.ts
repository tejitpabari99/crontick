// Job execution engine: spawns child processes, enforces overlap policies,
// retry with backoff, timeout, and stream capture with secret redaction.
// See docs/internals/executors.md
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { platform } from 'node:os';
import { basename } from 'node:path';
import type { Job, PromptAction } from '../schemas/job.js';
import type { Store, RunStatus, LogStream } from './store.js';
import { CrontickError } from '../errors.js';
import { extractSessionId } from './prompt-session.js';
import { buildPromptRunCommand, loadConfig } from '../config.js';
import { createStreamingTextRedactor, nullLogger, redactText, type Logger, type StreamingTextRedactor } from '../logger.js';
import { isProcessAlive, isSameRunProcess } from '../process-liveness.js';
import { readEnvFileForAction } from './env-file.js';
import { createJobLogFileFactory, type JobLogFile, type JobLogFileFactory } from './job-log-file.js';

// ── Output cap (L5) ───────────────────────────────────────────────────────────

/**
 * Default bytes captured per run before further stdout/stderr is dropped
 * (mirrors `retention.maxOutputBytesPerRun` on RetentionConfig, see
 * src/schemas/config.ts). Used as the fallback when config loading fails;
 * see resolveMaxOutputBytesPerRun().
 */
export const DEFAULT_MAX_OUTPUT_BYTES_PER_RUN = 2_000_000;

/** Marker line appended exactly once when a run's captured output hits the cap. */
export function truncationMarker(maxBytes: number): string {
  return `\n[crontick] output truncated: exceeded ${maxBytes} bytes (retention.maxOutputBytesPerRun); further output from this run is not stored\n`;
}

/** Reads retention.maxOutputBytesPerRun; falls back to the default if config loading itself fails. */
function resolveMaxOutputBytesPerRun(): number {
  try {
    return loadConfig().retention.maxOutputBytesPerRun;
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

interface SafeRedactResult {
  chunk: Buffer;
  textLike: boolean;
}

/**
 * Redact secrets from a chunk only when it is valid UTF-8 text.
 * Binary data (NUL bytes or lossy UTF-8 round-trip) is stored as-is.
 */
function safeRedact(chunk: Buffer, redactor?: StreamingTextRedactor): SafeRedactResult {
  // NUL byte → likely binary, skip redaction
  if (chunk.includes(0)) return { chunk, textLike: false };
  const str = chunk.toString('utf8');
  // Lossy round-trip → binary or non-UTF-8, skip redaction
  if (!Buffer.from(str, 'utf8').equals(chunk)) return { chunk, textLike: false };
  const cleaned = redactor ? redactor.write(str) : redactText(str);
  return { chunk: Buffer.from(cleaned, 'utf8'), textLike: true };
}

function flushSafeRedactor(redactor: StreamingTextRedactor): Buffer {
  const cleaned = redactor.flush();
  return cleaned.length === 0 ? Buffer.alloc(0) : Buffer.from(cleaned, 'utf8');
}

/**
 * Trims trailing bytes that would split a multi-byte UTF-8 character in two.
 * The output byte cap (captureChunk()) cuts a chunk at an arbitrary byte
 * offset; without this, the last stored bytes before the truncation marker
 * can be an incomplete UTF-8 sequence, corrupting whatever reads the log
 * back as text. Only ever removes bytes from the very end of `buf` (never
 * adds/reorders), so callers can safely pass the result straight to
 * safeRedact()/store.appendLog().
 */
export function truncateToUtf8Boundary(buf: Buffer): Buffer {
  const len = buf.length;
  if (len === 0) return buf;
  const scanStart = Math.max(0, len - 4); // longest UTF-8 sequence is 4 bytes
  for (let i = len - 1; i >= scanStart; i--) {
    const byte = buf[i]!;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte — keep scanning back for its lead byte
    let seqLen: number;
    if ((byte & 0x80) === 0x00) seqLen = 1;
    else if ((byte & 0xe0) === 0xc0) seqLen = 2;
    else if ((byte & 0xf0) === 0xe0) seqLen = 3;
    else if ((byte & 0xf8) === 0xf0) seqLen = 4;
    else return buf; // not a valid UTF-8 lead byte — not a boundary split, leave untouched
    return i + seqLen <= len ? buf : buf.subarray(0, i);
  }
  // Ran out of scan window without finding a lead byte (>=4 trailing
  // continuation bytes) — already-invalid input; leave untouched.
  return buf;
}

const ACTION_CWD_INVALID_ERROR_CODE = 'ACTION_CWD_INVALID';

function buildActionCwdError(
  actionKind: Job['action']['kind'],
  cwd: string,
  reason: 'missing' | 'not-directory',
): CrontickError {
  const detail = reason === 'missing' ? 'does not exist' : 'is not a directory';
  return new CrontickError(
    ACTION_CWD_INVALID_ERROR_CODE,
    `${ACTION_CWD_INVALID_ERROR_CODE}: ${actionKind} action cwd ${detail}: "${cwd}". Update action.cwd to an existing directory before the next run.`,
  );
}

function validateActionCwd(action: Job['action']): void {
  const cwd = action.cwd;
  if (!cwd) return;

  let cwdStats;
  try {
    cwdStats = statSync(cwd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw buildActionCwdError(action.kind, cwd, 'missing');
    }
    throw err;
  }

  if (!cwdStats.isDirectory()) {
    throw buildActionCwdError(action.kind, cwd, 'not-directory');
  }
}

// ── Per-run log writer ──────────────────────────────────────────────────────

/**
 * Fans a run's log output out to two sinks: the SQLite run-log store (queried
 * by `crontick logs` and the dashboard) and the per-job log file (best-effort
 * mirror on disk). Engine output uses the `stdout`/`stderr` streams; crontick's
 * own scheduling/execution lifecycle events use the `crontick` stream so a
 * caller can filter engine-only vs crontick-only logs (see store.LogSource).
 */
class RunLogWriter {
  constructor(
    private readonly store: Store,
    private readonly file: JobLogFile,
    private readonly runId: string,
  ) {}

  /** Persist an engine (or already-formatted) chunk to the store and mirror to the file. */
  append(stream: LogStream, chunk: Buffer): void {
    this.store.appendLog(this.runId, stream, chunk);
    // Best-effort mirror: a misbehaving sink must never block or crash a run.
    try {
      this.file.write(chunk.toString('utf-8'));
    } catch {
      // swallowed — the store copy is the source of truth; file logging is a mirror.
    }
  }

  /** Record a crontick-side lifecycle event (redacted) on the `crontick` stream. */
  crontick(message: string, data?: unknown): void {
    const suffix = data === undefined ? '' : ` ${redactText(JSON.stringify(data))}`;
    this.append('crontick', Buffer.from(`[crontick] ${message}${suffix}\n`, 'utf-8'));
  }
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
  private readonly jobLogFiles: JobLogFileFactory;

  constructor(
    private readonly spawnFn: typeof spawn = spawn,
    logger: Logger = nullLogger,
    private readonly maxOutputBytesPerRunOverride?: number,
    /** Test-only seam: overrides ADOPTED_RUN_POLL_MS so adoptRun() tests don't wait 3s per poll tick. */
    private readonly adoptedPollMsOverride?: number,
    /** Injectable per-job log-file factory (defaults to the real fs-backed sink). */
    jobLogFiles?: JobLogFileFactory,
  ) {
    this.logger = logger.child('runner');
    this.jobLogFiles = jobLogFiles ?? createJobLogFileFactory(this.logger);
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
    // Fetched once here (not re-queried every poll tick) since startedAt is
    // immutable for a run; used below to re-verify pid identity on every
    // tick, not just at this initial reconciliation moment.
    const startedAt = store.getRun(runId)?.startedAt;

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
      // L3 fix: re-verify pid identity every tick, not just isProcessAlive().
      // If the adopted process exited between ticks and the OS reused its pid
      // for an unrelated process, isProcessAlive(pid) alone would keep
      // reporting "alive" forever, and a later cancel-previous/skip decision
      // would send SIGTERM to that unrelated process. isSameRunProcess also
      // checks the OS-reported start time against this run's startedAt.
      // undefined (inconclusive — start time unavailable) errs toward "still
      // alive", matching reconcileOrphanRuns()'s conservative contract.
      const alive = startedAt === undefined ? isProcessAlive(pid) : isSameRunProcess(pid, startedAt) !== false;
      if (alive) return;
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
    const log = new RunLogWriter(store, this.jobLogFiles.open(job.id), runId);
    this.logger.debug('Starting run orchestration', { jobId: job.id, runId, overlap, retryMax: job.retry?.max ?? 0 });
    this.appendDiagnosticLog(log, 'run orchestration', { jobId: job.id, overlap, retryMax: job.retry?.max ?? 0 });

    const isActive = this.activeRunIds.has(job.id);

    if (overlap === 'skip' && isActive) {
      log.crontick('run skipped: overlap=skip, another run is already active', { jobId: job.id });
      await this.finalizeRun(store, runId, {
        status: 'canceled',
        error: 'overlap=skip: another run is already active',
      }, log);
      this.logger.debug('Canceled run due to overlap=skip', { jobId: job.id, runId });
      return;
    }

    if (overlap === 'cancel-previous' && isActive) {
      const ctrl = this.activeAborts.get(job.id);
      if (ctrl) ctrl.abort();
      this.logger.debug('Canceled previous active run for job', { jobId: job.id, runId });
    }

    if (overlap === 'queue') {
      await this.enqueue(job, runId, store, log);
    } else {
      await this.execute(job, runId, store, log);
    }
  }

  private enqueue(job: Job, runId: string, store: Store, log: RunLogWriter): Promise<void> {
    return new Promise<void>((resolve) => {
      const queue = this.queues.get(job.id) ?? [];
      queue.push(async () => {
        await this.execute(job, runId, store, log);
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

  private async execute(job: Job, runId: string, store: Store, log: RunLogWriter): Promise<void> {
    const maxRetries = job.retry?.max ?? 0;
    const backoffSec = job.retry?.backoffSec ?? 30;
    let lastResult: RunResult = { status: 'failed', error: 'not started' };

    store.updateRun(runId, { status: 'running' });
    log.crontick('run started', { jobId: job.id, action: job.action.kind, overlap: job.overlap ?? 'skip', retryMax: maxRetries });

    const ctrl = new AbortController();
    this.activeAborts.set(job.id, ctrl);
    this.activeRunIds.set(job.id, runId);

    try {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          this.logger.debug('Retry backoff before run attempt', { jobId: job.id, runId, attempt, backoffSec });
          this.appendDiagnosticLog(log, 'retry backoff', { attempt, backoffSec });
          await sleep(backoffSec * 1000);
        }
        // Check abort before each retry attempt (cancel-previous or manual cancel)
        if (ctrl.signal.aborted) {
          lastResult = { status: 'canceled', error: 'canceled before retry' };
          break;
        }
        try {
          lastResult = await this.spawn(job, runId, store, ctrl.signal, log);
        } catch (err) {
          lastResult = this.runResultFromError(err, ctrl.signal);
          this.logger.error('Run attempt failed before child completion', {
            jobId: job.id,
            runId,
            attempt,
            status: lastResult.status,
            error: lastResult.error,
          });
          this.appendDiagnosticLog(log, 'attempt failed before child completion', {
            attempt,
            status: lastResult.status,
            error: lastResult.error,
          });
        }
        this.logger.debug('Run attempt completed', { jobId: job.id, runId, attempt, status: lastResult.status, exitCode: lastResult.exitCode });
        this.appendDiagnosticLog(log, 'attempt completed', { attempt, status: lastResult.status, exitCode: lastResult.exitCode });
        if (lastResult.status === 'success') break;
        if (lastResult.status === 'canceled' || lastResult.status === 'timeout') break;
      }
    } finally {
      // Only clear if these maps still point to THIS run's state. A newer run
      // via cancel-previous may have already overwritten them.
      if (this.activeAborts.get(job.id) === ctrl) this.activeAborts.delete(job.id);
      if (this.activeRunIds.get(job.id) === runId) this.activeRunIds.delete(job.id);
    }

    await this.finalizeRun(store, runId, lastResult, log);
  }

  private async spawn(
    job: Job,
    runId: string,
    store: Store,
    signal: AbortSignal,
    log: RunLogWriter,
  ): Promise<RunResult> {
    const { action } = job;
    validateActionCwd(action);

    let promptEnv: Record<string, string> = {};

    const latestJob = store.getJob(job.id);
    const promptSessionJob = latestJob?.action.kind === 'prompt' ? latestJob : job;
    const latestAction =
      promptSessionJob.action.kind === 'prompt' ? promptSessionJob.action : action;
    const sessionId = latestAction.sessionId ?? action.sessionId;
    const capturePromptSession = latestAction.reuseSession && !sessionId;
    const promptCaptureAction: PromptAction | undefined = capturePromptSession ? latestAction : undefined;
    if (sessionId && latestAction.reuseSession) {
      log.append(
        'crontick',
        Buffer.from('[crontick] notice: reuseSession was ignored because an explicit sessionId was provided.\n', 'utf-8'),
      );
    }
    // Persist an explicitly-provided session id onto the run record now
    // (an extracted one is persisted from the close handler below).
    if (sessionId) {
      try {
        store.updateRun(runId, { sessionId });
      } catch (err) {
        this.logger.error('Failed to persist run sessionId', { jobId: job.id, runId, error: String(err) });
      }
    }

    const runCommand = buildPromptRunCommand({ ...latestAction, sessionId }, { logger: this.logger });
    const cmd = runCommand.command;
    const promptEngineBinary = runCommand.engine;
    const args = runCommand.args;
    promptEnv = runCommand.env;
    this.logger.debug('Resolved prompt run command', { jobId: job.id, runId, engine: promptEngineBinary, command: cmd, args, envKeys: Object.keys(promptEnv) });
    this.appendDiagnosticLog(log, 'resolved prompt command', { engine: promptEngineBinary, command: cmd, args, envKeys: Object.keys(promptEnv) });

    log.crontick('executing', { command: cmd, args });

    // Persist the redacted resolved command onto the run record so
    // `crontick runs get <id>` can show exactly what was executed for this
    // specific run, independent of any later edits to the job definition.
    try {
      store.updateRun(runId, { command: redactText([cmd, ...args].join(' ')) });
    } catch (err) {
      this.logger.error('Failed to persist run command', { jobId: job.id, runId, error: String(err) });
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
    //
    // EXCEPTION — pwsh/powershell.exe on Windows: Node's `detached: true` maps to
    // Win32's DETACHED_PROCESS creation flag there (libuv src/win/process.c), which
    // gives the child no console at all. PowerShell's host requires an attached
    // console to initialize and, without one, never reaches the point of writing to
    // its (still perfectly valid) stdout/stderr handles — confirmed by reproducing
    // with both pipe- and file-redirected stdio: both come back completely empty,
    // while the same detached spawn works fine for cmd.exe and node.exe (see
    // nodejs/node#51018). windowsHide is unrelated and not the cause (verified
    // independently). Silent output loss is unacceptable, so for this one
    // command/platform combination we deliberately drop `detached` and accept the
    // trade-off: a pwsh/powershell.exe script job's child will NOT survive the
    // daemon being killed via Ctrl+C propagated through the shared console (though
    // an abrupt crash/kill -9 still leaves it running, since Windows doesn't
    // cascade-kill unrelated processes on its own). Every other shell/command keeps
    // both guarantees.
    const isWindowsPowerShellHost = platform() === 'win32' && isPowerShellHostCommand(cmd);
    const spawnOpts: Parameters<typeof spawn>[2] = {
      cwd: action.cwd ?? process.cwd(),
      env: { ...process.env, ...promptEnv, ...(action.env ?? {}) } as NodeJS.ProcessEnv,
      signal,
      shell: false,
      detached: !isWindowsPowerShellHost,
      windowsHide: true,
    };
    if (isWindowsPowerShellHost) {
      this.appendDiagnosticLog(log, 'detached disabled for pwsh/powershell.exe on Windows (output-capture trade-off, see runner.ts)');
    }

    // Merge envFile variables (lower priority than action.env, higher than process.env).
    const envFile = readEnvFileForAction(action);
    if (envFile) {
      spawnOpts.env = {
        ...process.env,
        ...promptEnv,
        ...envFile.vars,
        ...(action.env ?? {}),
      } as NodeJS.ProcessEnv;
      this.logger.debug('Loaded env file for run', { jobId: job.id, runId, envFile: envFile.path, envKeys: Object.keys(envFile.vars) });
    }

    // Timeout enforcement (L-timeout): tracked manually rather than via spawn()'s
    // `timeout` option. Node's own timeout kills with SIGTERM and fires `close`
    // with (code: null, signal: 'SIGTERM') — it never emits an 'error' with
    // ETIMEDOUT, so that branch in the 'error' handler below was unreachable, and
    // the close handler's generic "killed by signal" check saw every timeout as a
    // plain SIGTERM and recorded status: 'canceled'. `timedOut` is set by our own
    // timer just before we send the same SIGTERM ourselves, so the close handler
    // can tell "we killed it because it ran too long" apart from "someone/something
    // else sent SIGTERM" and record status: 'timeout' accordingly.
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    // Prompt session ID extraction only needs the last ~128 KB of combined
    // output. Rather than reallocating (concat + subarray) on every stdout
    // chunk — O(n^2) for chatty prompts — we retain incoming chunks in an
    // array and drop whole leading chunks once the buffered bytes still cover
    // the cap without them. The exact last-maxTranscriptBytes tail is only
    // materialized once, at process close (see readTranscriptTail).
    const maxTranscriptBytes = 128 * 1024;
    const transcriptChunks: Buffer[] = [];
    let transcriptBytes = 0;
    const appendTranscript = (chunk: Buffer) => {
      if (!capturePromptSession) return;
      transcriptChunks.push(chunk);
      transcriptBytes += chunk.byteLength;
      // Evict leading chunks while the remainder still fully covers the cap,
      // so we never keep more than the last chunk beyond maxTranscriptBytes.
      while (
        transcriptChunks.length > 1 &&
        transcriptBytes - transcriptChunks[0].byteLength >= maxTranscriptBytes
      ) {
        transcriptBytes -= transcriptChunks[0].byteLength;
        transcriptChunks.shift();
      }
    };
    const readTranscriptTail = (): string => {
      const combined = transcriptChunks.length === 1 ? transcriptChunks[0] : Buffer.concat(transcriptChunks);
      const tail =
        combined.byteLength > maxTranscriptBytes
          ? combined.subarray(combined.byteLength - maxTranscriptBytes)
          : combined;
      return tail.toString('utf-8');
    };

    // Byte cap on captured output (L5): re-read per run (not cached at Runner
    // construction) so a config change via `crontick daemon reload` takes
    // effect for new runs without a full restart, mirroring the
    // maxRunsPerJob reload pattern. The child process itself is never
    // killed or throttled here — only persistence of further chunks stops.
    const maxOutputBytes = this.maxOutputBytesPerRunOverride ?? resolveMaxOutputBytesPerRun();
    let capturedBytes = 0;
    let outputTruncated = false;
    const streamRedactors: Record<'stdout' | 'stderr', StreamingTextRedactor> = {
      stdout: createStreamingTextRedactor(),
      stderr: createStreamingTextRedactor(),
    };
    const flushRedactor = (stream: 'stdout' | 'stderr'): void => {
      const flushed = flushSafeRedactor(streamRedactors[stream]);
      if (flushed.length > 0) log.append(stream, flushed);
    };
    const captureChunk = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (outputTruncated) return; // marker already emitted; drop silently, child keeps running
      const redactor = streamRedactors[stream];
      if (capturedBytes + chunk.length > maxOutputBytes) {
        const room = Math.max(0, maxOutputBytes - capturedBytes);
        // truncateToUtf8Boundary (L5 fix): the cap cuts at an arbitrary byte
        // offset — trim back to a full character so the last stored bytes
        // before the marker are never an invalid, split UTF-8 sequence.
        if (room > 0) {
          const redacted = safeRedact(truncateToUtf8Boundary(chunk.subarray(0, room)), redactor);
          if (!redacted.textLike) flushRedactor(stream);
          if (redacted.chunk.length > 0) log.append(stream, redacted.chunk);
        }
        flushRedactor(stream);
        log.append(stream, Buffer.from(truncationMarker(maxOutputBytes), 'utf-8'));
        try {
          store.updateRun(runId, { outputTruncated: true });
        } catch (err) {
          this.logger.error('Failed to persist outputTruncated flag', { jobId: job.id, runId, error: String(err) });
        }
        outputTruncated = true;
        return;
      }
      capturedBytes += chunk.length;
      const redacted = safeRedact(chunk, redactor);
      if (!redacted.textLike) flushRedactor(stream);
      if (redacted.chunk.length > 0) log.append(stream, redacted.chunk);
    };
    const result = await new Promise<RunResult>((resolve) => {
      const timeoutMs = action.timeoutSec ? action.timeoutSec * 1000 : undefined;
      this.logger.debug('Spawning child process', { jobId: job.id, runId, command: cmd, args, cwd: spawnOpts.cwd, timeoutMs });
      this.appendDiagnosticLog(log, 'spawn', { command: cmd, args, cwd: spawnOpts.cwd, timeoutMs });
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
      if (timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          try {
            if (!signal.aborted) child.kill('SIGTERM');
          } catch {
            // already gone
          }
        }, timeoutMs);
        timeoutHandle.unref?.();
      }
      const startedAt = Date.now();
      const captureAction = promptCaptureAction;
      let settled = false;
      const finish = (runResult: RunResult) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
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
        try {
          flushRedactor('stdout');
          flushRedactor('stderr');
        } catch (err) {
          finish({ status: 'failed', error: `RUNNER_CALLBACK_FAILED: ${errorMessage(err)}` });
          return;
        }
        const durationMs = Date.now() - startedAt;
        this.logger.debug('Child process closed', { jobId: job.id, runId, code, signal: sig, durationMs });
        this.appendDiagnosticLog(log, 'child closed', { code, signal: sig, durationMs });
        if (signal.aborted) {
          finish({ status: 'canceled', error: 'aborted' });
        } else if (timedOut) {
          // Checked before the generic signal branch below: our own timer sent
          // this SIGTERM, so close() looks identical to a user cancellation
          // (code: null, signal: 'SIGTERM') unless we track intent ourselves.
          finish({ status: 'timeout', error: `run exceeded timeoutSec (${action.timeoutSec}s)` });
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
            const sessionId = extractSessionId(readTranscriptTail());
            if (!sessionId) {
              this.logger.debug('Session id capture failed', { jobId: job.id, runId });
              finish({
                status: 'failed',
                exitCode: code,
                error: 'SESSION_ID_NOT_FOUND: prompt engine output did not include a session id. Configure an explicit session id with --session-id <id>, or disable reuseSession.',
              });
              return;
            }
            // Persist the extracted session id onto the run record (for the
            // dashboard and `runs get`), independent of whether the job-level
            // capture below wins its race.
            try {
              store.updateRun(runId, { sessionId });
            } catch (err) {
              this.logger.error('Failed to persist run sessionId', { jobId: job.id, runId, error: String(err) });
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
                  log.append('crontick', Buffer.from(`[crontick] captured session id: ${sessionId}\n`, 'utf-8'));
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
        this.appendDiagnosticLog(log, 'child error', { code: err.code, message: err.message });
        if (err.code === 'ABORT_ERR' || signal.aborted) {
          finish({ status: 'canceled', error: 'aborted' });
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
  }


  private runResultFromError(err: unknown, signal: AbortSignal): RunResult {
    if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR' || signal.aborted) {
      return { status: 'canceled', error: 'aborted' };
    }
    return { status: 'failed', error: errorMessage(err) };
  }

  private async finalizeRun(store: Store, runId: string, result: RunResult, log?: RunLogWriter): Promise<void> {
    const run = store.getRun(runId);
    const now = Date.now();
    const durationMs = run ? now - run.startedAt : undefined;
    store.updateRun(runId, {
      status: result.status,
      exitCode: result.exitCode,
      error: result.error,
      endedAt: now,
      durationMs,
    });
    log?.crontick('run finished', { status: result.status, exitCode: result.exitCode, durationMs, error: result.error });
    this.logger.debug('Finalized run', { runId, status: result.status, exitCode: result.exitCode, durationMs });
  }

  private appendDiagnosticLog(log: RunLogWriter, message: string, data?: unknown): void {
    if (!this.logger.isDebugEnabled()) return;
    const suffix = data === undefined ? '' : ` ${redactText(JSON.stringify(data))}`;
    log.append('stderr', Buffer.from(`[crontick:debug] ${message}${suffix}\n`, 'utf-8'));
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

/**
 * True if `cmd` invokes PowerShell (Core `pwsh` or Windows PowerShell
 * `powershell`), by executable basename, case-insensitively and with/without
 * a `.exe` suffix or leading path. Used to disable `detached` on Windows only
 * for this specific command (see the spawnOpts comment in spawn()) — every
 * other command keeps detached:true.
 */
function isPowerShellHostCommand(cmd: string): boolean {
  const name = basename(cmd).toLowerCase().replace(/\.exe$/, '');
  return name === 'pwsh' || name === 'powershell';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

