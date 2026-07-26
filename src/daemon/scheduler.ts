// Per-job timer management: cron (via croner), interval, and one-shot schedules.
// Emits 'tick' events consumed by the daemon to trigger runs.
// See docs/internals/scheduler.md
import { EventEmitter } from 'node:events';
import { Cron, type CronOptions } from 'croner';
import type { Job, Schedule } from '../schemas/job.js';
import { nullLogger, type Logger } from '../logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TickEvent {
  jobId: string;
  plannedAt: Date;
}

export interface PreviewOptions {
  n?: number;
  tz?: string;
}

export interface ValidateResult {
  ok: boolean;
  error?: string;
}

/** Result of enumerateFiresBetween(): the fires found (capped) plus whether more existed beyond the cap. */
export interface EnumerateFiresResult {
  /** Ascending epoch-ms fire times, length <= the requested cap. */
  fires: number[];
  /** True if the schedule had more fires in the window than the cap allowed to enumerate. */
  capped: boolean;
}

/** Default cap for enumerateFiresBetween() when the caller doesn't specify one. */
export const DEFAULT_ENUMERATE_FIRES_CAP = 500;

// ── Scheduler ─────────────────────────────────────────────────────────────────

export class Scheduler extends EventEmitter {
  private entries: Map<string, { stop: () => void }> = new Map();
  private readonly logger: Logger;

  constructor(logger: Logger = nullLogger) {
    super();
    this.logger = logger.child('scheduler');
  }

  /** Register a timer for a job. Calls unschedule first (idempotent re-schedule without leaking timers). */
  schedule(job: Job): void {
    this.unschedule(job.id);

    if (!job.enabled) {
      this.logger.debug('Skipping disabled job', { jobId: job.id });
      return;
    }

    const { schedule } = job;
    if (schedule.kind === 'cron') {
      this.logger.debug('Scheduling cron job', { jobId: job.id, cron: schedule.cron, tz: schedule.tz });
      this.scheduleCron(job, schedule.cron, schedule.tz);
    } else if (schedule.kind === 'interval') {
      this.logger.debug('Scheduling interval job', { jobId: job.id, everySec: schedule.everySec, startAt: schedule.startAt });
      this.scheduleInterval(job, schedule.everySec, schedule.startAt);
    } else if (schedule.kind === 'one-shot') {
      this.logger.debug('Scheduling one-shot job', { jobId: job.id, runAt: schedule.runAt });
      this.scheduleOneShot(job, schedule.runAt);
    }
  }

  unschedule(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (entry) {
      entry.stop();
      this.entries.delete(jobId);
      this.logger.debug('Unscheduled job', { jobId });
    }
  }

  unscheduleAll(): void {
    for (const jobId of [...this.entries.keys()]) {
      this.unschedule(jobId);
    }
  }

  // ── Preview / Validate ─────────────────────────────────────────────────────

  /** Compute the next N fire times without registering timers (side-effect free). */
  previewNext(schedule: Schedule, opts: PreviewOptions = {}): string[] {
    const n = opts.n ?? 5;

    if (schedule.kind === 'cron') {
      return cronNextN(schedule.cron, opts.tz ?? schedule.tz, n);
    }

    if (schedule.kind === 'interval') {
      const now = Date.now();
      const intervalMs = schedule.everySec * 1000;
      const results: string[] = [];
      for (let i = 1; i <= n; i++) {
        results.push(new Date(now + i * intervalMs).toISOString());
      }
      return results;
    }

    if (schedule.kind === 'one-shot') {
      const t = new Date(schedule.runAt);
      if (isNaN(t.getTime())) return [];
      return t > new Date() ? [t.toISOString()] : [];
    }

    return [];
  }

  /** Validate structural correctness of a schedule without side effects. */
  validateSchedule(schedule: Schedule): ValidateResult {
    if (schedule.kind === 'cron') {
      try {
        const cron = new Cron(schedule.cron, { paused: true });
        cron.stop();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }

    if (schedule.kind === 'interval') {
      if (schedule.everySec <= 0) {
        return { ok: false, error: 'everySec must be positive' };
      }
      if (schedule.startAt && isNaN(new Date(schedule.startAt).getTime())) {
        return { ok: false, error: 'startAt is not a valid ISO-8601 date' };
      }
      return { ok: true };
    }

    if (schedule.kind === 'one-shot') {
      const t = new Date(schedule.runAt);
      if (isNaN(t.getTime())) {
        return { ok: false, error: 'runAt is not a valid ISO-8601 date' };
      }
      return { ok: true };
    }

    return { ok: false, error: 'Unknown schedule kind' };
  }

  // ── Missed-fire enumeration ─────────────────────────────────────────────────

  /**
   * Enumerate the fire times a schedule would have produced strictly between
   * `fromExclusiveMs` and `toExclusiveMs`, without registering any live timer
   * — used only by the daemon's startup missed-fire pass (see
   * docs/concepts/daemon-lifecycle.md and Store.recordMissedRun()). Bounded
   * by `opts.cap` (default 500) so a pathological every-second job left down
   * for a long time can't stall startup or flood `runs` with individual rows;
   * when the cap is hit, the caller records one synthetic summary row instead
   * of iterating further. `fromExclusiveMs >= toExclusiveMs` (clock moved
   * backwards, or nothing to compute) returns zero fires rather than
   * throwing.
   */
  enumerateFiresBetween(
    schedule: Schedule,
    fromExclusiveMs: number,
    toExclusiveMs: number,
    opts: { cap?: number } = {},
  ): EnumerateFiresResult {
    const cap = opts.cap ?? DEFAULT_ENUMERATE_FIRES_CAP;
    if (fromExclusiveMs >= toExclusiveMs) return { fires: [], capped: false };

    if (schedule.kind === 'cron') {
      return enumerateCronFires(schedule.cron, schedule.tz, fromExclusiveMs, toExclusiveMs, cap);
    }
    if (schedule.kind === 'interval') {
      return enumerateIntervalFires(schedule.everySec, fromExclusiveMs, toExclusiveMs, cap);
    }
    if (schedule.kind === 'one-shot') {
      const t = new Date(schedule.runAt).getTime();
      if (isNaN(t) || t <= fromExclusiveMs || t >= toExclusiveMs) return { fires: [], capped: false };
      return { fires: [t], capped: false };
    }
    return { fires: [], capped: false };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private fireTick(jobId: string, plannedAt: Date): void {
    this.emit('tick', { jobId, plannedAt } satisfies TickEvent);
  }

  private scheduleCron(
    job: Job,
    pattern: string,
    tz: string | undefined,
  ): void {
    const options: CronOptions = {};
    if (tz) options.timezone = tz;

    const cron = new Cron(pattern, options, () => {
      this.fireTick(job.id, new Date());
    });

    this.entries.set(job.id, { stop: () => cron.stop() });
  }

  private scheduleInterval(
    job: Job,
    everySec: number,
    startAt: string | undefined,
  ): void {
    const intervalMs = everySec * 1000;

    // Calculate initial delay:
    // - No startAt → wait one full interval.
    // - startAt in the future → fire at startAt.
    // - startAt in the past → align to the next interval boundary so the cadence
    //   is preserved relative to the original start.
    let delay = intervalMs;
    if (startAt) {
      const startTime = new Date(startAt);
      if (!isNaN(startTime.getTime())) {
        const now = Date.now();
        const startMs = startTime.getTime();
        if (startMs > now) {
          delay = startMs - now;
        } else {
          const elapsed = now - startMs;
          delay = intervalMs - (elapsed % intervalMs);
        }
      }
    }

    // Stable disposer: the SAME closure identity is stored in `entries` for the
    // entire lifetime of this job's schedule, across both the pre-fire (timeout)
    // and post-fire (interval) phases — unlike the old code, which replaced the
    // map entry object when the timer transitioned. `disposed` guards against
    // unschedule() being called synchronously from within this job's own first
    // tick listener: without the guard, the code below would unconditionally
    // re-arm a setInterval even though the job was just unscheduled from inside
    // its own tick callback (see docs/internals/scheduler.md).
    let disposed = false;
    let currentTimer: { clear(): void } = safeSetTimeout(() => {
      if (disposed) return;
      this.fireTick(job.id, new Date());
      if (disposed) return;
      const interval = setInterval(() => this.fireTick(job.id, new Date()), intervalMs);
      currentTimer = { clear: () => clearInterval(interval) };
    }, delay);

    this.entries.set(job.id, {
      stop: () => {
        disposed = true;
        currentTimer.clear();
      },
    });
  }

  private scheduleOneShot(job: Job, runAt: string): void {
    const t = new Date(runAt);
    if (isNaN(t.getTime())) return;

    const delay = t.getTime() - Date.now();
    // One-shot whose time has already passed: silently skip (no retroactive firing).
    if (delay <= 0) {
      return;
    }

    const timer = safeSetTimeout(() => {
      this.fireTick(job.id, t);
      this.entries.delete(job.id);
    }, delay);

    this.entries.set(job.id, { stop: () => timer.clear() });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * setTimeout clamps delays > 2^31-1 ms (~24.8 days) to 1 ms, causing
 * far-future timers to fire immediately. This helper chains intermediate
 * 2,000,000,000 ms timeouts until the remaining delay is within the safe range.
 */
const MAX_SAFE_TIMEOUT_MS = 2_000_000_000;

interface SafeTimer {
  clear(): void;
}

function safeSetTimeout(cb: () => void, ms: number): SafeTimer {
  if (ms <= MAX_SAFE_TIMEOUT_MS) {
    const t = setTimeout(cb, ms);
    return { clear: () => clearTimeout(t) };
  }
  let inner: SafeTimer | undefined;
  const t = setTimeout(() => {
    inner = safeSetTimeout(cb, ms - MAX_SAFE_TIMEOUT_MS);
  }, MAX_SAFE_TIMEOUT_MS);
  return {
    clear: () => {
      clearTimeout(t);
      inner?.clear();
    },
  };
}

/** Iterate croner's nextRun() forward from `fromExclusiveMs`, capped, without registering a live timer. */
function enumerateCronFires(
  pattern: string,
  tz: string | undefined,
  fromExclusiveMs: number,
  toExclusiveMs: number,
  cap: number,
): EnumerateFiresResult {
  try {
    const options: CronOptions = { paused: true };
    if (tz) options.timezone = tz;
    const cron = new Cron(pattern, options);
    const fires: number[] = [];
    let ref = new Date(fromExclusiveMs);
    let capped = false;
    for (;;) {
      const next = cron.nextRun(ref) as Date | null;
      if (!next || next.getTime() >= toExclusiveMs) break;
      if (fires.length >= cap) {
        capped = true;
        break;
      }
      fires.push(next.getTime());
      ref = new Date(next.getTime() + 1);
    }
    cron.stop();
    return { fires, capped };
  } catch {
    return { fires: [], capped: false };
  }
}

/** Compute equally-spaced interval fires forward from `fromExclusiveMs`, capped. */
function enumerateIntervalFires(
  everySec: number,
  fromExclusiveMs: number,
  toExclusiveMs: number,
  cap: number,
): EnumerateFiresResult {
  const intervalMs = everySec * 1000;
  if (intervalMs <= 0) return { fires: [], capped: false };
  const fires: number[] = [];
  let t = fromExclusiveMs + intervalMs;
  let capped = false;
  while (t < toExclusiveMs) {
    if (fires.length >= cap) {
      capped = true;
      break;
    }
    fires.push(t);
    t += intervalMs;
  }
  return { fires, capped };
}

/** Iterate croner's nextRun() N times from now without registering a live timer. */
function cronNextN(pattern: string, tz: string | undefined, n: number): string[] {
  try {
    const options: CronOptions = { paused: true };
    if (tz) options.timezone = tz;
    const cron = new Cron(pattern, options);
    const results: string[] = [];
    let ref: Date | undefined;
    for (let i = 0; i < n; i++) {
      const next = cron.nextRun(ref) as Date | null;
      if (!next) break;
      results.push(next.toISOString());
      ref = new Date(next.getTime() + 1);
    }
    cron.stop();
    return results;
  } catch {
    return [];
  }
}
