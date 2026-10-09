/**
 * Startup missed-fire scan + SP10 catch-up dispatch (extracted from `main()`
 * so it is unit-testable). The scan records missed fires for ordinary jobs and
 * collects one pending catch-up per enabled `catchUp` job; the dispatch step
 * runs after the runner, orphan reconciliation and the tick/after listeners
 * exist. Reload never calls either.
 */
import type { Logger } from '../logger.js';
import { isTimeSchedule } from '../schemas/job.js';
import {
  CATCH_UP_MISSED_ENV,
  CATCH_UP_SKIP_PREFIX,
  CATCH_UP_TRIGGER_ENV,
  CATCH_UP_TRIGGER_VALUE,
} from '../constants/catch-up.js';
import type { Scheduler } from './scheduler.js';
import type { Store } from './store.js';
import { dispatchTimeRun, type TimeDispatchDeps } from './time-dispatch.js';

export interface MissedFireSummary {
  jobsWithMissedFires: number;
  /** Rows recorded as 'missed' (catch-up jobs record 'skipped' instead). */
  missedRunsRecorded: number;
  jobsCapped: number;
  capPerJob: number;
  /** Catch-up runs started at this startup. */
  catchUpRuns: number;
}

export interface PendingCatchUp {
  jobId: string;
  /** Latest missed fire: becomes the run's plannedAt. */
  plannedAt: Date;
  /** Number of fires missed (a lower bound when capped). */
  missed: number;
  /** Enumerated fires superseded by the catch-up run (excludes `plannedAt`). */
  superseded: number[];
  capped: boolean;
  /** Capped only: ISO bounds of the enumerated window, for the summary row wording. */
  window?: { earliest: string; latest: string };
}

export interface ScanDeps {
  store: Store;
  scheduler: Scheduler;
  logger: Logger;
  nowMs: number;
  cap: number;
}

export function scanMissedFires(deps: ScanDeps): { summary: MissedFireSummary; pending: PendingCatchUp[] } {
  const { store, scheduler, logger, nowMs, cap } = deps;
  const summary: MissedFireSummary = {
    jobsWithMissedFires: 0,
    missedRunsRecorded: 0,
    jobsCapped: 0,
    capPerJob: cap,
    catchUpRuns: 0,
  };
  const pending: PendingCatchUp[] = [];
  for (const job of store.listJobs()) {
    if (!isTimeSchedule(job.schedule)) continue; // event-driven kinds have no fire times to miss
    if (!job.enabled) {
      // Never back-fill a stale gap when the job is re-enabled later.
      store.recordTick(job.id, nowMs);
      continue;
    }
    const state = store.getScheduleState(job.id);
    if (!state) {
      store.recordTick(job.id, nowMs);
      continue;
    }
    // A pending catch-up keeps its old watermark until dispatchCatchUps resolves it, so a
    // crash or dispatch failure between scan and dispatch cannot silently drop the fires.
    let deferTick = false;
    try {
      const result = scheduler.enumerateFiresBetween(job.schedule, state.lastTickAt, nowMs, { cap });
      if (result.fires.length > 0) {
        summary.jobsWithMissedFires++;
        if (result.capped) summary.jobsCapped++;
      }
      const earliest = result.fires.length > 0 ? new Date(result.fires[0]).toISOString() : '';
      const latestEnumerated = result.fires.length > 0 ? new Date(result.fires[result.fires.length - 1]).toISOString() : '';
      if (job.catchUp && result.fires.length > 0) {
        const last = result.fires[result.fires.length - 1];
        const target = result.capped
          ? scheduler.latestFireBefore(job.schedule, state.lastTickAt, nowMs) ?? last
          : last;
        deferTick = true;
        pending.push({
          jobId: job.id,
          plannedAt: new Date(target),
          missed: result.fires.length,
          // Capped: every enumerated fire stands in for the summary row (one row, not 500).
          superseded: result.capped ? [last] : result.fires.slice(0, -1),
          capped: result.capped,
          ...(result.capped ? { window: { earliest, latest: latestEnumerated } } : {}),
        });
      } else if (result.capped) {
        summary.missedRunsRecorded++;
        store.recordMissedRun(
          job.id,
          result.fires[result.fires.length - 1],
          `MISSED: ${result.fires.length}+ fires missed between ${earliest} and ${latestEnumerated} (capped at ${cap}, only a summary recorded)`,
        );
      } else if (result.fires.length > 0) {
        for (const plannedAt of result.fires) store.recordMissedRun(job.id, plannedAt);
        summary.missedRunsRecorded += result.fires.length;
      }
    } catch (err) {
      logger.error('Missed-fire computation failed for job; skipping', { jobId: job.id, error: String(err) });
    }
    if (!deferTick) store.recordTick(job.id, nowMs);
  }
  return { summary, pending };
}

/**
 * Dispatches each pending catch-up through the normal time-fire path, then
 * records the superseded fires as 'skipped' (naming the run), or as 'missed'
 * when the job was disabled/removed before dispatch. Restores the watermark to
 * `nowMs` afterwards (dispatch sets it to the fire time).
 */
export function dispatchCatchUps(
  deps: TimeDispatchDeps,
  pending: PendingCatchUp[],
  summary: MissedFireSummary,
  nowMs: number,
): void {
  const { store, logger } = deps;
  for (const p of pending) {
    try {
      const result = dispatchTimeRun(deps, p.jobId, p.plannedAt, {
        env: { [CATCH_UP_TRIGGER_ENV]: CATCH_UP_TRIGGER_VALUE, [CATCH_UP_MISSED_ENV]: String(p.missed) },
      });
      if ('skipped' in result) {
        for (const at of p.superseded) store.recordMissedRun(p.jobId, at);
        store.recordMissedRun(p.jobId, p.plannedAt.getTime());
        summary.missedRunsRecorded += p.superseded.length + 1;
        store.recordTick(p.jobId, nowMs);
        continue;
      }
      summary.catchUpRuns++;
      const reason = `${CATCH_UP_SKIP_PREFIX} ${result.runId}`;
      for (const at of p.superseded) {
        const note = p.capped && p.window
          ? `${reason} (${p.missed}+ fires missed between ${p.window.earliest} and ${p.window.latest}, capped at ${p.missed}; only a summary recorded)`
          : reason;
        store.recordSkippedRun(p.jobId, at, note);
      }
      store.recordTick(p.jobId, nowMs);
    } catch (err) {
      logger.error('Catch-up dispatch failed for job; recording its fires as missed', { jobId: p.jobId, error: String(err) });
      try {
        for (const at of p.superseded) store.recordMissedRun(p.jobId, at);
        store.recordMissedRun(p.jobId, p.plannedAt.getTime());
        summary.missedRunsRecorded += p.superseded.length + 1;
        store.recordTick(p.jobId, nowMs);
      } catch (err2) {
        logger.error('Could not record missed fires after catch-up failure', { jobId: p.jobId, error: String(err2) });
      }
    }
  }
}
