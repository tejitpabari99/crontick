import { EventEmitter } from 'node:events';
import { Cron, type CronOptions } from 'croner';
import type { Job, Schedule } from '../schemas/job.js';
import type { Store } from './store.js';

// ── Cron alias expansion ──────────────────────────────────────────────────────

const CRON_ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@noon': '0 12 * * *',
  '@hourly': '0 * * * *',
  '@every_minute': '* * * * *',
};

/** Expand a cron alias like @daily → '0 0 * * *', or return expr unchanged. */
export function expandCronAlias(expr: string): string {
  return CRON_ALIASES[expr.toLowerCase()] ?? expr;
}

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

// ── Scheduler ─────────────────────────────────────────────────────────────────

export class Scheduler extends EventEmitter {
  private entries: Map<string, { stop: () => void }> = new Map();

  /**
   * Schedule a job, handling catchup based on the last run time from the store.
   * On daemon start pass `store` so catchup can be resolved; at runtime it's optional.
   */
  schedule(job: Job, store?: Store): void {
    this.unschedule(job.id); // idempotent

    if (!job.enabled) return;

    const { schedule } = job;
    const lastRun = store?.getLastRun(job.id);
    const lastRunAt = lastRun ? new Date(lastRun.startedAt) : undefined;

    if (schedule.kind === 'cron') {
      this.scheduleCron(job, expandCronAlias(schedule.cron), schedule.tz, lastRunAt);
    } else if (schedule.kind === 'interval') {
      this.scheduleInterval(job, schedule.everySec, schedule.startAt, lastRunAt);
    } else if (schedule.kind === 'one-shot') {
      this.scheduleOneShot(job, schedule.runAt);
    }
  }

  unschedule(jobId: string): void {
    const entry = this.entries.get(jobId);
    if (entry) {
      entry.stop();
      this.entries.delete(jobId);
    }
  }

  unscheduleAll(): void {
    for (const jobId of [...this.entries.keys()]) {
      this.unschedule(jobId);
    }
  }

  // ── Preview / Validate ─────────────────────────────────────────────────────

  previewNext(schedule: Schedule, opts: PreviewOptions = {}): string[] {
    const n = opts.n ?? 5;

    if (schedule.kind === 'cron') {
      return cronNextN(expandCronAlias(schedule.cron), opts.tz ?? schedule.tz, n);
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

  validateSchedule(schedule: Schedule): ValidateResult {
    if (schedule.kind === 'cron') {
      try {
        const cron = new Cron(expandCronAlias(schedule.cron), { paused: true });
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

  // ── Private helpers ────────────────────────────────────────────────────────

  private fireTick(jobId: string, plannedAt: Date): void {
    this.emit('tick', { jobId, plannedAt } satisfies TickEvent);
  }

  private scheduleCron(
    job: Job,
    pattern: string,
    tz: string | undefined,
    lastRunAt: Date | undefined,
  ): void {
    // Handle catchup before starting recurring schedule
    this.handleCronCatchup(job, pattern, tz, lastRunAt);

    const options: CronOptions = {};
    if (tz) options.timezone = tz;

    const cron = new Cron(pattern, options, () => {
      this.fireTick(job.id, new Date());
    });

    this.entries.set(job.id, { stop: () => cron.stop() });
  }

  private handleCronCatchup(
    job: Job,
    pattern: string,
    tz: string | undefined,
    lastRunAt: Date | undefined,
  ): void {
    if (job.catchup === 'skip' || !lastRunAt) return;

    const now = new Date();
    const missed = missedCronFires(pattern, tz, lastRunAt, now);
    if (missed.length === 0) return;

    if (job.catchup === 'run-once') {
      setImmediate(() => this.fireTick(job.id, missed[missed.length - 1]));
    } else if (job.catchup === 'run-all') {
      for (const t of missed) {
        const capturedT = t;
        setImmediate(() => this.fireTick(job.id, capturedT));
      }
    }
  }

  private scheduleInterval(
    job: Job,
    everySec: number,
    startAt: string | undefined,
    lastRunAt: Date | undefined,
  ): void {
    const intervalMs = everySec * 1000;

    // Handle catchup
    if (lastRunAt && job.catchup !== 'skip') {
      const elapsed = Date.now() - lastRunAt.getTime();
      const missedCount = Math.floor(elapsed / intervalMs);
      if (missedCount > 0) {
        if (job.catchup === 'run-once') {
          setImmediate(() => this.fireTick(job.id, new Date()));
        } else if (job.catchup === 'run-all') {
          for (let i = 0; i < missedCount; i++) {
            setImmediate(() => this.fireTick(job.id, new Date()));
          }
        }
      }
    }

    // Calculate initial delay
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

    const timer = safeSetTimeout(() => {
      this.fireTick(job.id, new Date());
      const interval = setInterval(() => this.fireTick(job.id, new Date()), intervalMs);
      this.entries.set(job.id, { stop: () => clearInterval(interval) });
    }, delay);

    this.entries.set(job.id, {
      stop: () => timer.clear(),
    });
  }

  private scheduleOneShot(job: Job, runAt: string): void {
    const t = new Date(runAt);
    if (isNaN(t.getTime())) return;

    const delay = t.getTime() - Date.now();
    if (delay <= 0) {
      if (job.catchup !== 'skip') {
        setImmediate(() => {
          this.fireTick(job.id, t);
          this.entries.delete(job.id);
        });
      }
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
 * `setTimeout` clamps delays > 2^31-1 ms (~24.8 days) to 1 ms, causing
 * far-future timers to fire immediately.  This helper chains intermediate
 * 2 000 000 000 ms timeouts until the remaining delay is safe.
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

function missedCronFires(
  pattern: string,
  tz: string | undefined,
  from: Date,
  to: Date,
): Date[] {
  try {
    const options: CronOptions = { paused: true };
    if (tz) options.timezone = tz;
    const cron = new Cron(pattern, options);
    const missed: Date[] = [];
    let ref: Date | undefined = from;
    for (;;) {
      const next = cron.nextRun(ref) as Date | null;
      if (!next || next > to) break;
      missed.push(next);
      ref = new Date(next.getTime() + 1);
      if (missed.length > 1000) break;
    }
    cron.stop();
    return missed;
  } catch {
    return [];
  }
}
