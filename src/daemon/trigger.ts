/**
 * Non-time trigger dispatch (SP05 `after`; SP06 `webhook` reuses it).
 *
 * `TriggerDispatcher.dispatch` starts a run for a job fired by a non-time event
 * and deliberately never calls `store.recordTick`: the schedule watermark is
 * time-only. Time fires (SP10 `dispatchTimeRun`) are a separate path.
 */
import type { Logger } from '../logger.js';
import type { Job } from '../schemas/job.js';
import type { RunCompleteEvent, Runner } from './runner.js';
import type { Store } from './store.js';

export interface TriggerRequest {
  /** Trigger kind; must equal the job's `schedule.kind`. SP06 adds 'webhook' here. */
  kind: 'after' | 'webhook';
  /** CRONTICK_TRIGGER + kind-specific vars (highest env priority). */
  env: Record<string, string>;
  /** Persisted to runs.trigger_json. */
  meta?: Record<string, unknown>;
  /** Appended to the prompt text (unused by `after`). */
  promptSuffix?: string;
}

export type TriggerSkipReason = 'not-found' | 'disabled' | 'kind-mismatch' | 'broken' | 'paused';
export type TriggerResult = { runId: string } | { skipped: TriggerSkipReason };

export interface TriggerDispatcherDeps {
  store: Store;
  runner: Runner;
  logger: Logger;
  /** True while the daemon or this job is paused (scheduler.isPaused() || scheduler.isJobPaused(id)). */
  isPaused?: (jobId: string) => boolean;
}

export class TriggerDispatcher {
  private readonly logger: Logger;

  constructor(private readonly deps: TriggerDispatcherDeps) {
    this.logger = deps.logger;
  }

  dispatch(jobId: string, req: TriggerRequest): TriggerResult {
    const { store, runner } = this.deps;
    const job: Job | undefined = store.getJob(jobId);
    if (!job) return { skipped: 'not-found' };
    if (!job.enabled) {
      this.logger.debug('Trigger ignored: job disabled', { jobId, kind: req.kind });
      return { skipped: 'disabled' };
    }
    if (job.schedule.kind !== req.kind) {
      this.logger.debug('Trigger ignored: schedule kind changed', { jobId, kind: req.kind, scheduleKind: job.schedule.kind });
      return { skipped: 'kind-mismatch' };
    }
    if (store.isJobBroken(job.id)) {
      this.logger.warn('Trigger ignored: job is broken', { jobId, kind: req.kind });
      return { skipped: 'broken' };
    }
    if (this.deps.isPaused?.(job.id)) {
      // Same as time fires due while paused: recorded as a terminal 'skipped' run, not replayed.
      const skipped = store.recordSkippedRun(job.id, Date.now());
      if (req.meta) store.setRunTrigger(skipped.id, req.meta);
      return { skipped: 'paused' };
    }
    const run = store.insertRun(job.id);
    if (req.meta) store.setRunTrigger(run.id, req.meta);
    runner
      .run(job, run.id, store, {
        env: req.env,
        ...(req.promptSuffix !== undefined ? { promptSuffix: req.promptSuffix } : {}),
      })
      .catch((err: unknown) => {
        this.logger.error('Runner error', { jobId, error: String(err) });
      });
    return { runId: run.id };
  }
}

/** Upstream terminal status -> dependent filter bucket; canceled/skipped/missed (R3) map to undefined. */
function failureOrSuccess(status: string): 'success' | 'failure' | undefined {
  if (status === 'success') return 'success';
  if (status === 'failed' || status === 'timeout') return 'failure';
  return undefined;
}

/**
 * Registers the `after` listener on the runner. Call AFTER startup reconciliation so runs
 * finalized at startup (and downtime completions) fire nothing; adopted runs exiting later do.
 */
export function registerAfterTrigger(deps: {
  runner: Runner;
  store: Store;
  dispatcher: TriggerDispatcher;
  logger: Logger;
}): void {
  const { runner, store, dispatcher, logger } = deps;
  runner.onRunComplete((event: RunCompleteEvent) => {
    const bucket = failureOrSuccess(event.status);
    if (!bucket) return;
    const upstream = store.getJob(event.jobId);
    for (const dep of store.listDependents(event.jobId)) {
      if (dep.schedule.kind !== 'after') continue;
      const want = dep.schedule.status;
      if (want !== 'any' && want !== bucket) continue;
      const env: Record<string, string> = {
        CRONTICK_TRIGGER: 'after',
        CRONTICK_UPSTREAM_RUN_ID: event.runId,
        CRONTICK_UPSTREAM_STATUS: event.status,
        CRONTICK_UPSTREAM_JOB_ID: event.jobId,
      };
      if (upstream?.alias) env['CRONTICK_UPSTREAM_JOB_ALIAS'] = upstream.alias;
      const res = dispatcher.dispatch(dep.id, { kind: 'after', env, meta: { kind: 'after', upstream: event.runId } });
      logger.debug('After trigger dispatched', { upstreamJobId: event.jobId, upstreamRunId: event.runId, dependent: dep.id, result: res });
    }
  });
}
