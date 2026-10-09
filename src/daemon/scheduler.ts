// Per-job timer management: cron (via croner), interval, and one-shot schedules.
// Emits 'tick' events consumed by the daemon to trigger runs.
// See docs/implementation/scheduler.md
import { EventEmitter } from 'node:events';
import { Cron, type CronOptions } from 'croner';
import { isTimeSchedule, type Job, type Schedule } from '../schemas/job.js';
import { nullLogger, type Logger } from '../logger.js';
import { DEFAULT_ENUMERATE_FIRES_CAP } from '../constants/scheduler.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TickEvent {
  jobId: string;
  plannedAt: Date;
}

export interface PreviewOptions {
  n?: number;
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

// ── Scheduler ─────────────────────────────────────────────────────────────────

function assertNever(x: never): never {
  throw new Error(`Unhandled schedule kind: ${JSON.stringify(x)}`);
}

export class Scheduler extends EventEmitter {
  private entries: Map<string, { stop: () => void }> = new Map();
  private readonly logger: Logger;
  /** In-memory only (never persisted): while true, fires emit 'paused-tick' instead of 'tick'. */
  private paused = false;
  /** In-memory only: jobs paused individually (a pending job update waiting on in-flight runs). */
  private pausedJobs: Set<string> = new Set();

  constructor(logger: Logger = nullLogger) {
    super();
    this.logger = logger.child('scheduler');
  }

  /** Pause: timers keep running but due fires emit 'paused-tick' (recorded skipped by the daemon), never 'tick'. Idempotent. */
  pause(): void {
    this.paused = true;
  }

  /** Resume normal scheduling. Idempotent. */
  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Pause a single job: its due fires emit 'paused-tick' while other jobs keep ticking. Idempotent. */
  pauseJob(jobId: string): void {
    this.pausedJobs.add(jobId);
  }

  resumeJob(jobId: string): void {
    this.pausedJobs.delete(jobId);
  }

  isJobPaused(jobId: string): boolean {
    return this.pausedJobs.has(jobId);
  }

  /** Register a timer for a job. Calls unschedule first (idempotent re-schedule without leaking timers). */
  schedule(job: Job): void {
    this.unschedule(job.id);

    if (!job.enabled) {
      this.logger.debug('Skipping disabled job', { jobId: job.id });
      return;
    }

    const { schedule } = job;
    if (!isTimeSchedule(schedule)) {
      this.logger.debug('Not scheduling non-time job', { jobId: job.id, kind: schedule.kind });
      return;
    }
    if (schedule.kind === 'cron') {
      this.logger.debug('Scheduling cron job', { jobId: job.id, cron: schedule.cron });
      this.scheduleCron(job, schedule.cron);
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

    switch (schedule.kind) {
      case 'cron':
        return cronNextN(schedule.cron, n);
      case 'interval':
        return this.previewInterval(schedule.everySec, n);
      case 'one-shot':
        return this.previewOneShot(schedule.runAt);
      case 'after':
      case 'webhook':
        return [];
      default:
        return assertNever(schedule);
    }
  }

  private previewInterval(everySec: number, n: number): string[] {
    const now = Date.now();
    const intervalMs = everySec * 1000;
    const results: string[] = [];
    for (let i = 1; i <= n; i++) {
      results.push(new Date(now + i * intervalMs).toISOString());
    }
    return results;
  }

  private previewOneShot(runAt: string): string[] {
    const t = new Date(runAt);
    if (isNaN(t.getTime())) return [];
    return t > new Date() ? [t.toISOString()] : [];
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

    if (schedule.kind === 'webhook') {
      // Event-driven: relay reachability is runtime state, not a schedule validity concern.
      return { ok: true };
    }

    if (schedule.kind === 'after') {
      // Upstream existence / cycles are validated by the daemon API, not the timer layer.
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

    switch (schedule.kind) {
      case 'cron':
        return enumerateCronFires(schedule.cron, fromExclusiveMs, toExclusiveMs, cap);
      case 'interval':
        return enumerateIntervalFires(schedule.everySec, schedule.startAt, fromExclusiveMs, toExclusiveMs, cap);
      case 'one-shot': {
        const t = new Date(schedule.runAt).getTime();
        if (isNaN(t) || t <= fromExclusiveMs || t >= toExclusiveMs) return { fires: [], capped: false };
        return { fires: [t], capped: false };
      }
      case 'after':
      case 'webhook':
        return { fires: [], capped: false };
      default:
        return assertNever(schedule);
    }
  }

  /**
   * Latest fire strictly between `fromExclusiveMs` and `toExclusiveMs`, computed directly
   * (not from the earliest-`cap` enumeration), so it is correct when enumeration is capped.
   * Returns null when there is none or the schedule is non-time (after/webhook).
   */
  latestFireBefore(schedule: Schedule, fromExclusiveMs: number, toExclusiveMs: number): number | null {
    if (fromExclusiveMs >= toExclusiveMs) return null;
    switch (schedule.kind) {
      case 'cron':
        return latestCronFire(schedule.cron, fromExclusiveMs, toExclusiveMs);
      case 'interval':
        return latestIntervalFire(schedule.everySec, schedule.startAt, fromExclusiveMs, toExclusiveMs);
      case 'one-shot': {
        const t = new Date(schedule.runAt).getTime();
        return isNaN(t) || t <= fromExclusiveMs || t >= toExclusiveMs ? null : t;
      }
      case 'after':
      case 'webhook':
        return null;
      default:
        return assertNever(schedule);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private fireTick(jobId: string, plannedAt: Date): void {
    this.emit(this.paused || this.pausedJobs.has(jobId) ? 'paused-tick' : 'tick', { jobId, plannedAt } satisfies TickEvent);
  }

  private scheduleCron(
    job: Job,
    pattern: string,
  ): void {
    // Cron expressions fire in the machine local timezone (croner's default).
    const options: CronOptions = {};

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
    // and post-fire (interval) phases (the map entry object is never replaced
    // when the timer transitions). `disposed` guards against
    // unschedule() being called synchronously from within this job's own first
    // tick listener: without the guard, the code below would unconditionally
    // re-arm a setInterval even though the job was just unscheduled from inside
    // its own tick callback (see docs/implementation/scheduler.md).
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
  fromExclusiveMs: number,
  toExclusiveMs: number,
  cap: number,
): EnumerateFiresResult {
  try {
    const options: CronOptions = { paused: true };
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

/** Parse an interval's startAt to epoch-ms; undefined when absent or invalid (live scheduler ignores invalid startAt). */
function parseStartAt(startAt: string | undefined): number | undefined {
  if (!startAt) return undefined;
  const ms = new Date(startAt).getTime();
  return isNaN(ms) ? undefined : ms;
}

/**
 * Compute equally-spaced interval fires in (fromExclusiveMs, toExclusiveMs), capped.
 * With a valid `startAt`, fires lie on the grid startAt + k*interval (k >= 0), matching the
 * live scheduler (none before startAt). Without it, the grid is anchored at `fromExclusiveMs`.
 */
function enumerateIntervalFires(
  everySec: number,
  startAt: string | undefined,
  fromExclusiveMs: number,
  toExclusiveMs: number,
  cap: number,
): EnumerateFiresResult {
  const intervalMs = everySec * 1000;
  if (intervalMs <= 0) return { fires: [], capped: false };
  const startMs = parseStartAt(startAt);
  let t: number;
  if (startMs === undefined) {
    t = fromExclusiveMs + intervalMs;
  } else if (startMs > fromExclusiveMs) {
    t = startMs;
  } else {
    t = startMs + (Math.floor((fromExclusiveMs - startMs) / intervalMs) + 1) * intervalMs;
  }
  const fires: number[] = [];
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

/** Latest interval fire in (from, to) computed directly (no enumeration); null if none. */
function latestIntervalFire(
  everySec: number,
  startAt: string | undefined,
  fromExclusiveMs: number,
  toExclusiveMs: number,
): number | null {
  const intervalMs = everySec * 1000;
  if (!(intervalMs > 0)) return null;
  const startMs = parseStartAt(startAt);
  let latest: number;
  if (startMs === undefined) {
    // Grid anchored at fromExclusiveMs: from + k*interval, k >= 1.
    const k = Math.ceil((toExclusiveMs - fromExclusiveMs) / intervalMs) - 1;
    if (k < 1) return null;
    latest = fromExclusiveMs + k * intervalMs;
  } else {
    if (startMs >= toExclusiveMs) return null;
    const k = Math.ceil((toExclusiveMs - startMs) / intervalMs) - 1;
    latest = startMs + k * intervalMs;
  }
  return latest > fromExclusiveMs && latest < toExclusiveMs ? latest : null;
}

/** Latest cron fire in (from, to): scan back over doubling windows ending at `to`; first non-empty window holds it. */
function latestCronFire(pattern: string, fromExclusiveMs: number, toExclusiveMs: number): number | null {
  let width = 60_000;
  let windowEnd = toExclusiveMs;
  for (;;) {
    const windowStart = Math.max(fromExclusiveMs, toExclusiveMs - width);
    const { fires } = enumerateCronFires(pattern, windowStart, windowEnd, Number.MAX_SAFE_INTEGER);
    if (fires.length > 0) return fires[fires.length - 1];
    if (windowStart <= fromExclusiveMs) return null;
    windowEnd = windowStart + 1; // windowStart itself is an exclusive bound of the scan; include it as a candidate
    width *= 2;
  }
}

/** Iterate croner's nextRun() N times from now without registering a live timer. */
function cronNextN(pattern: string, n: number): string[] {
  try {
    const options: CronOptions = { paused: true };
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
