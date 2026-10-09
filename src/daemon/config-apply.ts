// Daemon-side "apply config with an in-flight run policy" flow (SP03 R16).
// `stop`: cancel every in-flight run, then apply + reload. `wait`: pause the
// scheduler, wait (no timeout) for in-flight runs to finish, apply + reload,
// then resume automatically. No choice with runs in flight is an error.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps, type ApplyOpsOptions, type ApplyOpsResult, type ConfigOp } from '../config.js';
import { IN_FLIGHT_CHOICES, PENDING_CONFIG_APPLY_FILE } from '../constants/config.js';
import { CrontickError } from '../errors.js';
import type { InFlightRun, Runner } from './runner.js';
import type { Scheduler } from './scheduler.js';

export type InFlightChoice = (typeof IN_FLIGHT_CHOICES)[number];

export interface ConfigApplyDeps {
  runner: Pick<Runner, 'listInFlight' | 'cancelAllInFlight' | 'waitForIdle'>;
  scheduler: Pick<Scheduler, 'pause' | 'resume' | 'isPaused'>;
  /** Reloads jobs/config into the live daemon (never disturbs running runs). */
  reload: () => Promise<void>;
  /** Directory holding the pending-wait marker (the daemon data dir). */
  dataDir: string;
  /** Injectable for tests; defaults to the real locked writer. */
  applyOps?: (ops: ConfigOp[], options: ApplyOpsOptions) => Promise<ApplyOpsResult>;
  now?: () => number;
}

export interface ConfigApplyRequest {
  ops: ConfigOp[];
  ifRevision?: string;
  inFlight?: InFlightChoice;
}

export interface ConfigApplyResult extends ApplyOpsResult {
  /** Policy that was actually used: `none` when nothing was in flight. */
  inFlightPolicy: 'none' | InFlightChoice;
  /** Runs that were in flight when the save started. */
  affectedRuns: InFlightRun[];
}

export interface LostPendingConfigApply {
  startedAt: number;
  keys: string[];
  runIds: string[];
}

function markerPath(dir: string): string {
  return join(dir, PENDING_CONFIG_APPLY_FILE);
}

/**
 * Read and remove a pending-wait marker left by a previous daemon session.
 * Returns it when found (the wait-then-apply was lost with the restart), else null.
 */
export function consumeLostPendingConfigApply(dir: string): LostPendingConfigApply | null {
  const file = markerPath(dir);
  if (!existsSync(file)) return null;
  let parsed: LostPendingConfigApply | null = null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Partial<LostPendingConfigApply>;
    parsed = {
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
      keys: Array.isArray(raw.keys) ? raw.keys.map(String) : [],
      runIds: Array.isArray(raw.runIds) ? raw.runIds.map(String) : [],
    };
  } catch {
    parsed = { startedAt: 0, keys: [], runIds: [] };
  }
  rmSync(file, { force: true });
  return parsed;
}

function describeRuns(runs: InFlightRun[]): string {
  return runs.map((r) => `${r.jobId} (run ${r.runId})`).join(', ');
}

/** Pause/resume handle the policy flow holds while it drains runs (global for config, per-job for a job update). */
interface SchedulerHold {
  isHeld(): boolean;
  hold(): void;
  release(): void;
}

interface InFlightPolicyOptions<T> {
  runner: Pick<Runner, 'listInFlight' | 'cancelAllInFlight' | 'waitForIdle'>;
  hold: SchedulerHold;
  /** Restrict the in-flight scope to one job; omitted = every run. */
  jobId?: string;
  choice?: InFlightChoice;
  /** Runs before anything is stopped, only when runs are in flight (bad input must not cancel work). */
  validate?: () => Promise<unknown> | unknown;
  /** Runs right before waiting for in-flight runs to finish (wait choice only). */
  onWait?: (affected: InFlightRun[]) => void;
  /** Always runs after the policy flow ends (success or failure), before the hold is released. */
  onSettled?: () => void;
  apply: (policy: 'none' | InFlightChoice, affected: InFlightRun[]) => Promise<T> | T;
}

/**
 * Shared stop/wait flow (config save and job update): nothing in flight applies
 * straight away; runs in flight with no choice is a RUNS_IN_FLIGHT error;
 * `stop` cancels them first; `wait` holds the scheduler and waits (no timeout).
 */
async function runWithInFlightPolicy<T>(o: InFlightPolicyOptions<T>): Promise<T> {
  // Serialize flows per scope so a second save cannot observe the first one's hold as a user pause.
  const scope = o.jobId ?? '*';
  const previous = policyQueue.get(scope) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((resolve) => { done = resolve; });
  policyQueue.set(scope, mine);
  await previous;
  try {
    return await runInFlightPolicyUnqueued(o);
  } finally {
    done();
    if (policyQueue.get(scope) === mine) policyQueue.delete(scope);
  }
}

const policyQueue = new Map<string, Promise<void>>();

async function runInFlightPolicyUnqueued<T>(o: InFlightPolicyOptions<T>): Promise<T> {
  if (o.choice !== undefined && !IN_FLIGHT_CHOICES.includes(o.choice)) {
    throw new CrontickError('INVALID_IN_FLIGHT_CHOICE', `inFlight must be one of: ${IN_FLIGHT_CHOICES.join(', ')}`, { inFlight: o.choice });
  }
  const inFlight = o.jobId === undefined ? o.runner.listInFlight() : o.runner.listInFlight(o.jobId);
  if (inFlight.length === 0) return o.apply('none', []);

  if (o.choice === undefined) {
    throw new CrontickError(
      'RUNS_IN_FLIGHT',
      `Runs are in flight: ${describeRuns(inFlight)}. Choose inFlight "stop" (cancel them, then apply) or "wait" (pause, let them finish, then apply and resume).`,
      { runs: inFlight },
    );
  }

  await o.validate?.();

  // Hold the scheduler so no new run starts between draining and applying.
  const wasHeld = o.hold.isHeld();
  o.hold.hold();
  try {
    if (o.choice === 'stop') {
      if (o.jobId === undefined) await o.runner.cancelAllInFlight();
      else await o.runner.cancelAllInFlight('canceled: job update stopped in-flight runs', o.jobId);
    } else {
      o.onWait?.(inFlight);
      if (o.jobId === undefined) await o.runner.waitForIdle();
      else await o.runner.waitForIdle(o.jobId);
    }
    return await o.apply(o.choice, inFlight);
  } finally {
    o.onSettled?.();
    // Only undo a hold this flow introduced; a user-requested pause stays.
    if (!wasHeld) o.hold.release();
  }
}

export async function applyConfigWithPolicy(deps: ConfigApplyDeps, req: ConfigApplyRequest): Promise<ConfigApplyResult> {
  const apply = deps.applyOps ?? applyOps;
  const applyOptions: ApplyOpsOptions = {
    // This code runs inside the daemon, so the daemon is by definition running.
    daemonRunning: () => true,
    ...(req.ifRevision !== undefined ? { ifRevision: req.ifRevision } : {}),
  };
  const marker = markerPath(deps.dataDir);
  return runWithInFlightPolicy<ConfigApplyResult>({
    runner: deps.runner,
    hold: { isHeld: () => deps.scheduler.isPaused(), hold: () => deps.scheduler.pause(), release: () => deps.scheduler.resume() },
    choice: req.inFlight,
    // Validate (revision, daemon guard, schema) before disturbing any run: a bad batch must not cancel work.
    validate: () => apply(req.ops, { ...applyOptions, dryRun: true }),
    onWait: (affected) => {
      const pending: LostPendingConfigApply = {
        startedAt: (deps.now ?? Date.now)(),
        keys: req.ops.map((o) => o.key),
        runIds: affected.map((r) => r.runId),
      };
      mkdirSync(deps.dataDir, { recursive: true });
      writeFileSync(marker, JSON.stringify(pending), 'utf-8');
    },
    onSettled: () => rmSync(marker, { force: true }),
    apply: async (policy, affected) => {
      const result = await apply(req.ops, applyOptions);
      await deps.reload();
      return { ...result, inFlightPolicy: policy, affectedRuns: affected };
    },
  });
}

export interface JobUpdateApplyDeps {
  runner: Pick<Runner, 'listInFlight' | 'cancelAllInFlight' | 'waitForIdle'>;
  scheduler: Pick<Scheduler, 'pauseJob' | 'resumeJob' | 'isJobPaused'>;
}

export interface JobUpdateApplyRequest<T> {
  jobId: string;
  inFlight?: InFlightChoice;
  /** Dry-run style validation, run before any run is stopped. */
  validate?: () => Promise<unknown> | unknown;
  /** Persists the job update; runs once the job's in-flight runs are gone. */
  apply: () => Promise<T> | T;
}

export interface JobUpdateApplyResult<T> {
  result: T;
  inFlightPolicy: 'none' | InFlightChoice;
  affectedRuns: InFlightRun[];
}

/** Job-update variant of the config flow: scope is one job's runs, and only that job is paused while waiting. */
export async function applyJobUpdateWithPolicy<T>(deps: JobUpdateApplyDeps, req: JobUpdateApplyRequest<T>): Promise<JobUpdateApplyResult<T>> {
  return runWithInFlightPolicy<JobUpdateApplyResult<T>>({
    runner: deps.runner,
    hold: {
      isHeld: () => deps.scheduler.isJobPaused(req.jobId),
      hold: () => deps.scheduler.pauseJob(req.jobId),
      release: () => deps.scheduler.resumeJob(req.jobId),
    },
    jobId: req.jobId,
    choice: req.inFlight,
    validate: req.validate,
    apply: async (policy, affected) => ({ result: await req.apply(), inFlightPolicy: policy, affectedRuns: affected }),
  });
}
