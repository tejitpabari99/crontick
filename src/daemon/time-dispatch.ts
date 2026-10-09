/**
 * Time-fire dispatch shared by scheduler ticks and SP10 startup catch-up.
 *
 * Unlike `TriggerDispatcher.dispatch` (non-time triggers, no watermark), this
 * records the schedule watermark (`recordTick`) because the watermark is
 * time-only. It is a normal `runner.run`, so overlap, retry, timeout and
 * auto-disable apply unchanged.
 */
import type { Logger } from '../logger.js';
import type { RunContext } from './run-context.js';
import type { Runner } from './runner.js';
import type { Store } from './store.js';

export interface TimeDispatchDeps {
  store: Store;
  runner: Runner;
  logger: Logger;
}

export type TimeDispatchResult = { runId: string } | { skipped: 'disabled' };

/**
 * Re-reads the job, inserts a run at `plannedAt`, advances the watermark and
 * starts the runner. Store errors throw synchronously (callers inside an
 * EventEmitter listener must catch); runner rejections are logged.
 */
export function dispatchTimeRun(
  deps: TimeDispatchDeps,
  jobId: string,
  plannedAt: Date,
  ctx?: RunContext,
): TimeDispatchResult {
  const { store, runner, logger } = deps;
  const job = store.getJob(jobId);
  if (!job || !job.enabled) return { skipped: 'disabled' };
  const run = store.insertRun(jobId, plannedAt.getTime());
  store.recordTick(jobId, plannedAt.getTime());
  const p = ctx === undefined ? runner.run(job, run.id, store) : runner.run(job, run.id, store, ctx);
  p.catch((err: unknown) => {
    logger.error('Runner error', { jobId, error: String(err) });
  });
  return { runId: run.id };
}
