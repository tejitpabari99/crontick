// Job execution engine: spawns child processes, enforces overlap policies,
// retry with backoff, timeout, and stream capture with secret redaction.
// See docs/implementation/prompt-execution.md
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { platform } from 'node:os';
import { basename } from 'node:path';
import type { Job, PromptAction } from '../schemas/job.js';
import type { Store, RunStatus } from './store.js';
import type { EngineOutput } from '../run-output.js';
import { EngineOutputCollector, type EngineOutputCollectorOptions } from './output-collector.js';
import { CrontickError } from '../errors.js';
import { resolvePromptRunCommand, loadConfig } from '../config.js';
import { dataDir } from '../paths.js';
import { nullLogger, redactText, redactValue, type Logger } from '../logger.js';
import { isProcessAlive, isSameRunProcess } from '../process-liveness.js';
import { readEnvFileForAction } from './env-file.js';
import { createJobLogFileFactory, type JobLogFile, type JobLogFileFactory } from './job-log-file.js';
import { readClaudeCompletionMarker, readClaudeHookTranscriptPath, removeClaudeCompletionMarker } from '../claude-completion-marker.js';
import { DEFAULT_MAX_OUTPUT_BYTES_PER_RUN } from '../constants/retention.js';
import { ADOPTED_RUN_POLL_MS, EXIT_CLOSE_GRACE_MS, KILL_GRACE_MS, DEFAULT_MAX_CONSECUTIVE_FAILURES, TERMINAL_ERROR_SETTLE_MS } from '../constants/daemon.js';
import { killProcessTree, type TreeKiller } from './process-tree.js';
import type { TerminalEngineError } from '../engines/types.js';
import { sleep } from '../utils/sleep.js';

// ── Output cap (L5) ───────────────────────────────────────────────────────────

/** Reads retention.maxOutputBytesPerRun; falls back to the default if config loading itself fails. */
function resolveMaxOutputBytesPerRun(): number {
  try {
    return loadConfig().retention.maxOutputBytesPerRun;
  } catch {
    return DEFAULT_MAX_OUTPUT_BYTES_PER_RUN;
  }
}

/** Reads maxConsecutiveFailures; falls back to the default if config loading itself fails. */
function resolveMaxConsecutiveFailures(): number {
  try {
    return loadConfig().maxConsecutiveFailures;
  } catch {
    return DEFAULT_MAX_CONSECUTIVE_FAILURES;
  }
}

// ── Adopted-run polling (L3/L4) ────────────────────────────────────────────────

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
  costUsd?: number;
  turns?: number;
  usageJson?: string;
  transcriptPath?: string;
  engineStatus?: string;
  /** Set when retrying cannot help (e.g. the engine reported an authentication failure). */
  noRetry?: boolean;
}

/** Claude result usage is per attempt; retries belong to one crontick run. */
/** Placeholder shown for the (long, generated) `--settings` value in stored/displayed commands. */
export const SESSION_END_HOOK_PLACEHOLDER = '<session-end-hook>';

/** Replace the value following `--settings` so the hook blob never reaches stored commands or logs. */
export function redactSettingsArg(args: readonly string[]): string[] {
  return args.map((arg, i) => (i > 0 && args[i - 1] === '--settings' ? SESSION_END_HOOK_PLACEHOLDER : arg));
}

function mergeUsageJson(previous: string | undefined, next: string | undefined): string | undefined {
  if (next === undefined) return previous;
  if (previous === undefined) return next;
  const merge = (left: unknown, right: unknown): unknown => {
    if (typeof left === 'number' && typeof right === 'number' && Number.isFinite(left) && Number.isFinite(right)) {
      return left + right;
    }
    if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object'
      && !Array.isArray(left) && !Array.isArray(right)) {
      const result: Record<string, unknown> = { ...left };
      for (const [key, value] of Object.entries(right)) result[key] = key in result ? merge(result[key], value) : value;
      return result;
    }
    return right;
  };
  return JSON.stringify(merge(JSON.parse(previous) as unknown, JSON.parse(next) as unknown));
}

type QueueEntry = () => Promise<void>;

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

function transcriptFileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (err) {
    if (['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) return false;
    throw err;
  }
}

// ── Per-run log writer ──────────────────────────────────────────────────────

/**
 * Per-run output handling. crontick never persists the engine's raw output:
 * stdout is trimmed line by line as it arrives (only the final result event
 * and the full stderr are kept, see `EngineOutputCollector`) so the parsed
 * result can be stored when the run finishes (see `finish()`), and crontick's
 * own scheduling and execution events go to the per-job log file (one line per
 * event, tagged with the run id). File writes are best-effort and never block
 * or fail a run.
 */
class RunLogWriter {
  private collector: EngineOutputCollector | undefined;

  constructor(
    private readonly file: JobLogFile,
    private readonly runId: string,
  ) {}

  /** Start collecting a fresh attempt's engine output (retries each get their own). */
  beginCapture(maxPlainBytes: number, onLine: (line: string) => void, options?: EngineOutputCollectorOptions): EngineOutputCollector {
    this.collector = new EngineOutputCollector(maxPlainBytes, onLine, options);
    return this.collector;
  }

  /** Parse the collected engine output into the view persisted for the run; undefined when the engine produced none. */
  parseCaptured(): EngineOutput | undefined {
    return this.collector?.toEngineOutput();
  }

  /** Record a crontick-side event (redacted) in the per-job log file. */
  crontick(message: string, data?: unknown): void {
    const suffix = data === undefined ? '' : ` ${redactText(JSON.stringify(data))}`;
    try {
      this.file.write(`${new Date().toISOString()} [run ${this.runId}] ${message}${suffix}\n`);
    } catch {
      // swallowed — file logging is best-effort.
    }
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
    /** Injectable file check so a resume miss can be tested without touching ~/.claude. */
    private readonly transcriptExists: (path: string) => boolean = transcriptFileExists,
    /** Injectable process-tree killer (defaults to taskkill /T /F on Windows, process-group kill on POSIX). */
    private readonly killTree: TreeKiller = killProcessTree,
    /** Injectable consecutive-failure limit (defaults to config `maxConsecutiveFailures`, read per terminal run). */
    private readonly maxConsecutiveFailuresOverride?: number,
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
          const marker = canceledByAbort ? undefined : readClaudeCompletionMarker(dataDir(), runId, run.sessionId);
          const hookTranscriptPath = readClaudeHookTranscriptPath(dataDir(), runId, run.sessionId);
          store.updateRun(runId, {
            status: marker ? (marker.exitStatus === 0 ? 'success' : 'failed') : 'canceled',
            ...(marker ? { exitCode: marker.exitStatus } : {}),
            ...(hookTranscriptPath ? { transcriptPath: hookTranscriptPath } : {}),
            error: canceledByAbort ? 'DAEMON_RESTART: adopted run was terminated'
              : marker ? (marker.exitStatus === 0 ? undefined : `CLAUDE_HOOK: SessionEnd reported exit status ${marker.exitStatus}`)
                : ADOPTED_RUN_EXITED_MESSAGE,
            endedAt: Date.now(),
          });
          const finished = store.getRun(runId);
          if (finished) this.recordRunOutcome(jobId, runId, { status: finished.status, error: finished.error }, store);
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
    const log = new RunLogWriter(this.jobLogFiles.open(job.id), runId);
    this.logger.debug('Starting run orchestration', { jobId: job.id, runId, overlap, retryMax: job.retry?.max ?? 0 });
    this.appendDiagnosticLog(log, 'run orchestration', { jobId: job.id, overlap, retryMax: job.retry?.max ?? 0 });

    const isActive = this.activeRunIds.has(job.id);

    if (overlap === 'skip' && isActive) {
      log.crontick('run skipped: overlap=skip, another run is already active', { jobId: job.id });
      await this.finalizeRun(store, runId, {
        status: 'skipped',
        error: 'overlap=skip: another run is already active',
      }, log);
      this.logger.debug('Skipped run due to overlap=skip', { jobId: job.id, runId });
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
    let totalCostUsd: number | undefined;
    let totalTurns: number | undefined;
    let combinedUsageJson: string | undefined;

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
          if (err instanceof CrontickError && err.code === 'SESSION_NOT_FOUND') break;
        } finally {
          // A daemon that observed the child finish has the definitive
          // parseResult outcome; remove any best-effort marker before retry.
          removeClaudeCompletionMarker(dataDir(), runId);
        }
        if (lastResult.costUsd !== undefined) totalCostUsd = (totalCostUsd ?? 0) + lastResult.costUsd;
        if (lastResult.turns !== undefined) totalTurns = (totalTurns ?? 0) + lastResult.turns;
        combinedUsageJson = mergeUsageJson(combinedUsageJson, lastResult.usageJson);
        this.logger.debug('Run attempt completed', { jobId: job.id, runId, attempt, status: lastResult.status, exitCode: lastResult.exitCode });
        this.appendDiagnosticLog(log, 'attempt completed', { attempt, status: lastResult.status, exitCode: lastResult.exitCode });
        if (lastResult.status === 'success') break;
        if (lastResult.status === 'canceled' || lastResult.status === 'timeout') break;
        if (lastResult.noRetry) break;
      }
    } finally {
      // Only clear if these maps still point to THIS run's state. A newer run
      // via cancel-previous may have already overwritten them.
      if (this.activeAborts.get(job.id) === ctrl) this.activeAborts.delete(job.id);
      if (this.activeRunIds.get(job.id) === runId) this.activeRunIds.delete(job.id);
    }

    await this.finalizeRun(store, runId, {
      ...lastResult,
      costUsd: totalCostUsd,
      turns: totalTurns,
      usageJson: combinedUsageJson,
    }, log);
    this.recordRunOutcome(job.id, runId, lastResult, store, log);
  }

  /**
   * Single recorder for every terminal run outcome (normal execution, adopted
   * runs, and runs finalized by restart reconciliation).
   * Auto-disable a job after `maxConsecutiveFailures` (config) consecutive failed runs.
   * `failed` and `timeout` count as failures; `success` resets the count;
   * `canceled`/`skipped` leave it unchanged. When the limit is reached on an
   * enabled job, it is persisted as `enabled: false` (the daemon's tick handler
   * then stops firing it) and the final run's error records why. Re-enabling
   * resets the count (see the /enable route in api.ts).
   */
  recordRunOutcome(jobId: string, runId: string, result: { status: string; error?: string | undefined }, store: Store, log?: RunLogWriter): void {
    try {
      if (result.status === 'success') {
        store.resetConsecutiveFailures(jobId);
        return;
      }
      if (result.status !== 'failed' && result.status !== 'timeout') return;
      const failures = store.incrementConsecutiveFailures(jobId);
      if (failures < (this.maxConsecutiveFailuresOverride ?? resolveMaxConsecutiveFailures())) return;
      const current = store.getJob(jobId);
      if (!current || !current.enabled) return;
      store.upsertJob({ ...current, enabled: false });
      const note = `AUTO_DISABLED: job disabled after ${failures} consecutive failed runs; fix the cause, then re-enable it (crontick jobs update <id|alias> --enable)`;
      store.updateRun(runId, { error: result.error ? `${result.error}\n${note}` : note });
      log?.crontick('job auto-disabled after consecutive failures', { jobId, consecutiveFailures: failures });
      this.logger.warn('Job auto-disabled after consecutive failed runs', { jobId, runId, consecutiveFailures: failures });
    } catch (err) {
      this.logger.error('Failed to track consecutive failures', { jobId, runId, error: String(err) });
    }
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
    // Persist an explicitly-provided session id onto the run record now
    // (an extracted one is persisted from the close handler below).
    if (sessionId) {
      try {
        store.updateRun(runId, { sessionId });
      } catch (err) {
        this.logger.error('Failed to persist run sessionId', { jobId: job.id, runId, error: String(err) });
      }
    }

    const { invocation: runCommand, adapter, engineOptions } = resolvePromptRunCommand(
      { ...latestAction, sessionId },
      { logger: this.logger },
      { runId, jobId: job.id, dataDir: dataDir() },
    );
    const cmd = runCommand.command;
    const promptEngineBinary = runCommand.engine;
    const args = runCommand.args;
    promptEnv = runCommand.env;
    const displayArgs = redactSettingsArg(args);
    this.logger.debug('Resolved prompt run command', { jobId: job.id, runId, engine: promptEngineBinary, command: cmd, args: displayArgs, envKeys: Object.keys(promptEnv) });
    this.appendDiagnosticLog(log, 'resolved prompt command', { engine: promptEngineBinary, command: cmd, args: displayArgs, envKeys: Object.keys(promptEnv) });

    if (sessionId) {
      const transcriptPath = adapter.resumeTranscriptPath(action.cwd ?? process.cwd(), sessionId, { ...process.env, ...promptEnv, ...(action.env ?? {}) });
      if (transcriptPath && !this.transcriptExists(transcriptPath)) {
        throw new CrontickError(
          'SESSION_NOT_FOUND',
          `SESSION_NOT_FOUND: session transcript is missing: "${transcriptPath}". Restore it or start a new session before retrying.`,
        );
      }
    }

    log.crontick('executing', { command: cmd, args: displayArgs });

    // Persist the redacted resolved command onto the run record so
    // `crontick runs get <id>` can show exactly what was executed for this
    // specific run, independent of any later edits to the job definition.
    try {
      store.updateRun(runId, { command: redactText([cmd, ...displayArgs].join(' ')) });
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
      stdio: ['ignore', 'pipe', 'pipe'],
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

    // Plain (non-event) stdout is capped per run (L5): re-read per run (not
    // cached at Runner construction) so a config change via `crontick daemon
    // reload` takes effect for new runs without a full restart. The child is
    // never killed or throttled; only storage of further plain output stops.
    // Stream-json events (adapters with parseStreamEvent) are trimmed as they
    // arrive and need no cap (see EngineOutputCollector); stderr has its own fixed cap.
    const maxOutputBytes = this.maxOutputBytesPerRunOverride ?? resolveMaxOutputBytesPerRun();
    let outputTruncated = false;
    let collector: EngineOutputCollector;
    const noteTruncation = (): void => {
      if (!collector.truncated || outputTruncated) return;
      outputTruncated = true;
      try {
        store.updateRun(runId, { outputTruncated: true });
      } catch (err) {
        this.logger.error('Failed to persist outputTruncated flag', { jobId: job.id, runId, error: String(err) });
      }
    };
    const captureChunk = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (stream === 'stderr') {
        collector.pushStderr(chunk);
        return;
      }
      collector.pushStdout(chunk);
      noteTruncation();
    };
    const result = await new Promise<RunResult>((resolve) => {
      const timeoutMs = action.timeoutSec ? action.timeoutSec * 1000 : undefined;
      this.logger.debug('Spawning child process', { jobId: job.id, runId, command: cmd, args: displayArgs, cwd: spawnOpts.cwd, timeoutMs });
      this.appendDiagnosticLog(log, 'spawn', { command: cmd, args: displayArgs, cwd: spawnOpts.cwd, timeoutMs });
      const child = this.spawnFn(cmd, args, spawnOpts);
      // Claude assigns an id before spawn. Persist it before attaching output
      // listeners, so even a process that emits immediately has a run id.
      if (runCommand.sessionId) {
        try {
          // While running, point at the computed transcript path; finish() prefers the hook-reported one.
          const computedTranscript = adapter.resumeTranscriptPath(action.cwd ?? process.cwd(), runCommand.sessionId, spawnOpts.env);
          store.updateRun(runId, {
            sessionId: runCommand.sessionId,
            ...(computedTranscript === undefined ? {} : { transcriptPath: computedTranscript }),
          });
        } catch (err) {
          this.logger.error('Failed to persist run sessionId', { jobId: job.id, runId, error: String(err) });
        }
      }
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

      // Process-lifecycle guards: a run must always finalize, even when the
      // child (or a grandchild holding its stdio) never exits on its own.
      let exited = false;
      let hardKillTimer: NodeJS.Timeout | undefined;
      let settleTimer: NodeJS.Timeout | undefined;
      let exitTimer: NodeJS.Timeout | undefined;
      let terminalError: TerminalEngineError | undefined;
      /** After SIGTERM, escalate to a forced tree kill, then finalize even if `close` never arrives. */
      const armHardKill = (forced?: () => RunResult): void => {
        if (exited || hardKillTimer) return;
        hardKillTimer = setTimeout(() => {
          if (exited) return;
          this.killTree(child, true);
          if (forced) {
            const t = setTimeout(() => finish(forced()), EXIT_CLOSE_GRACE_MS);
            t.unref?.();
          }
        }, KILL_GRACE_MS);
        hardKillTimer.unref?.();
      };
      if (timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          try {
            if (!signal.aborted) child.kill('SIGTERM');
          } catch {
            // already gone
          }
          armHardKill(() => ({ status: 'timeout', error: `run exceeded timeoutSec (${action.timeoutSec}s)` }));
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
        if (settleTimer) clearTimeout(settleTimer);
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

      // Structured engines (Claude stream-json) announce failure in-band. Every
      // complete stdout line is checked as it arrives so a reported error ends
      // the run immediately instead of waiting for the process to exit.
      const parseEvent = adapter.parseStreamEvent?.bind(adapter);
      if (!parseEvent) {
        const message = `no adapter support for runner '${promptEngineBinary}', running generic output handling (stdout treated as plain text)`;
        this.logger.warn(message, { jobId: job.id, runId });
        log.crontick(`warning: ${message}`);
      }
      collector = log.beginCapture(maxOutputBytes, (line) => {
        if (settled) return;
        const detected = adapter.detectTerminalError(line);
        if (detected) onTerminalError(detected);
      }, parseEvent ? { parseEvent } : {});

      child.stdout?.on('data', (chunk: Buffer) => {
        try {
          captureChunk('stdout', chunk);
        } catch (err) {
          failFromCallback(err);
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        try {
          captureChunk('stderr', chunk);
        } catch (err) {
          failFromCallback(err);
        }
      });

      /** Parse the engine output captured so far into the run's final result and finish. */
      const settleFromOutput = (code: number | null): void => {
        collector.end();
        noteTruncation();
        const source = collector.parseSource();
        const parsed = adapter.parseResult(code, source.stdout, source.stderr);
        const resumableSessionId = adapter.resumableSessionId(parsed);
        if (resumableSessionId) {
          try {
            store.markCompletedClaudeSession(runId, resumableSessionId);
          } catch (err) {
            this.logger.error('Failed to mark Claude session as completed', { jobId: job.id, runId, error: String(err) });
          }
        }
        // Prefer the transcript path Claude reported to the SessionEnd hook; fall
        // back to the computed one (CLAUDE_CONFIG_DIR-aware) when it did not.
        const transcriptSessionId = parsed.sessionId ?? runCommand.sessionId;
        const hookTranscriptPath = transcriptSessionId === undefined
          ? undefined
          : readClaudeHookTranscriptPath(dataDir(), runId, transcriptSessionId);
        const result: RunResult = {
          status: parsed.status,
          exitCode: parsed.exitCode,
          error: parsed.error,
          costUsd: parsed.costUsd,
          turns: parsed.turns,
          usageJson: parsed.usage === undefined ? undefined : JSON.stringify(redactValue(parsed.usage)),
          transcriptPath: hookTranscriptPath ?? (transcriptSessionId === undefined
            ? undefined
            : adapter.resumeTranscriptPath(action.cwd ?? process.cwd(), transcriptSessionId, spawnOpts.env)),
          engineStatus: parsed.engineStatus,
        };
        if (terminalError) {
          result.status = 'failed';
          result.error = terminalError.message;
          if (!terminalError.retryable) result.noRetry = true;
        }
        if (capturePromptSession && adapter.canCaptureSession(parsed)) {
          const resolvedSessionId = adapter.resolveSessionId(engineOptions, parsed);
          if (!resolvedSessionId) {
            this.logger.debug('Session id capture failed', { jobId: job.id, runId });
            finish({
              ...result,
              status: 'failed',
              error: 'SESSION_ID_NOT_FOUND: prompt engine output did not include a session id. Configure an explicit session id with --session-id <id>, or disable reuseSession.',
            });
            return;
          }
          // Persist the extracted session id onto the run record (for the
          // dashboard and `runs get`), independent of whether the job-level
          // capture below wins its race.
          try {
            store.updateRun(runId, { sessionId: resolvedSessionId });
          } catch (err) {
            this.logger.error('Failed to persist run sessionId', { jobId: job.id, runId, error: String(err) });
          }
          if (captureAction) {
            let persisted = false;
            try {
              persisted = store.tryCapturePromptSession(job.id, captureAction, resolvedSessionId);
            } catch (err) {
              finish({
                ...result,
                status: 'failed',
                error: `SESSION_PERSIST_FAILED: ${errorMessage(err)}`,
              });
              return;
            }
            if (persisted) {
              this.logger.debug('Session id captured and persisted', { jobId: job.id, runId });
              try {
                log.crontick('captured session id', { sessionId: resolvedSessionId });
              } catch (err) {
                finish({
                  ...result,
                  status: 'failed',
                  error: `SESSION_PERSIST_FAILED: ${errorMessage(err)}`,
                });
                return;
              }
            }
          }
        }
        finish(result);
      };

      const onTerminalError = (detected: TerminalEngineError): void => {
        if (settled) return;
        terminalError = terminalError
          ? { message: detected.message, retryable: detected.retryable && terminalError.retryable }
          : detected;
        if (!settleTimer) {
          // A healthy engine exits right after reporting the error; give it a
          // moment to do so (exit code, session hooks), then end the run anyway.
          settleTimer = setTimeout(settleTerminal, TERMINAL_ERROR_SETTLE_MS);
          settleTimer.unref?.();
        }
      };

      const settleTerminal = (): void => {
        if (settled || !terminalError) return;
        log.crontick('engine reported a terminal error; ending run and terminating the process tree', {
          error: terminalError.message,
          retryable: terminalError.retryable,
        });
        try {
          settleFromOutput(null);
        } catch (err) {
          finish({ status: 'failed', error: terminalError.message, noRetry: !terminalError.retryable });
          this.logger.error('Failed to build result for terminal engine error', { jobId: job.id, runId, error: String(err) });
        }
        this.killTree(child, false);
        armHardKill();
      };

      const onClosed = (code: number | null, sig: NodeJS.Signals | null): void => {
        exited = true;
        if (hardKillTimer) clearTimeout(hardKillTimer);
        if (exitTimer) clearTimeout(exitTimer);
        try {
          collector.end();
        noteTruncation();
        } catch (err) {
          finish({ status: 'failed', error: `RUNNER_CALLBACK_FAILED: ${errorMessage(err)}` });
          return;
        }
        const durationMs = Date.now() - startedAt;
        this.logger.debug('Child process closed', { jobId: job.id, runId, code, signal: sig, durationMs });
        this.appendDiagnosticLog(log, 'child closed', { code, signal: sig, durationMs });
        if (settled) return;
        if (signal.aborted) {
          finish({ status: 'canceled', error: 'aborted' });
        } else if (timedOut) {
          // Checked before the generic signal branch below: our own timer sent
          // this SIGTERM, so close() looks identical to a user cancellation
          // (code: null, signal: 'SIGTERM') unless we track intent ourselves.
          finish({ status: 'timeout', error: `run exceeded timeoutSec (${action.timeoutSec}s)` });
        } else if (!terminalError && (sig === 'SIGTERM' || sig === 'SIGKILL')) {
          finish({ status: 'canceled', error: `killed by signal ${sig}` });
        } else {
          settleFromOutput(code);
        }
      };

      child.on('close', onClosed);
      // `close` waits for stdio to drain; a grandchild that inherited the pipes
      // can hold it open long after the process itself is gone. Finalize from
      // `exit` after a short grace so such a run cannot stay "running" forever.
      child.on('exit', (code, sig) => {
        exited = true;
        if (hardKillTimer) clearTimeout(hardKillTimer);
        if (settled || exitTimer) return;
        exitTimer = setTimeout(() => onClosed(code, sig), EXIT_CLOSE_GRACE_MS);
        exitTimer.unref?.();
      });

      if (signal.aborted) {
        armHardKill(() => ({ status: 'canceled', error: 'aborted' }));
      } else {
        signal.addEventListener('abort', () => armHardKill(() => ({ status: 'canceled', error: 'aborted' })), { once: true });
      }

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
      costUsd: result.costUsd,
      turns: result.turns,
      usageJson: result.usageJson,
      transcriptPath: result.transcriptPath,
      engineStatus: result.engineStatus,
    });
    const engineOutput = log?.parseCaptured();
    if (engineOutput) {
      try {
        store.setRunOutput(runId, engineOutput);
      } catch (err) {
        this.logger.error('Failed to persist run output', { runId, error: String(err) });
      }
    }
    log?.crontick('run finished', { status: result.status, exitCode: result.exitCode, durationMs, error: result.error });
    this.logger.debug('Finalized run', { runId, status: result.status, exitCode: result.exitCode, durationMs });
  }

  private appendDiagnosticLog(log: RunLogWriter, message: string, data?: unknown): void {
    if (!this.logger.isDebugEnabled()) return;
    log.crontick(`[debug] ${message}`, data);
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
