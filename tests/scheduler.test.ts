import { describe, it, expect, afterEach, vi } from 'vitest';
import { Scheduler } from '../src/daemon/scheduler.js';
import type { Job } from '../src/schemas/job.js';

function makeCronJob(id: string, cron: string, catchup: Job['catchup'] = 'skip'): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'cron', cron },
    action: { kind: 'exec', command: 'echo', args: [] },
    catchup,
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
    budgets: { maxRunsPerDay: null, maxTokensPerRun: null },
  };
}

function makeIntervalJob(id: string, everySec: number): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'interval', everySec },
    action: { kind: 'exec', command: 'echo', args: [] },
    catchup: 'skip',
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
    budgets: { maxRunsPerDay: null, maxTokensPerRun: null },
  };
}

function makeOneShotJob(id: string, runAt: string): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'one-shot', runAt },
    action: { kind: 'exec', command: 'echo', args: [] },
    catchup: 'skip',
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
    budgets: { maxRunsPerDay: null, maxTokensPerRun: null },
  };
}

describe('Scheduler', () => {
  let scheduler: Scheduler;

  afterEach(() => {
    scheduler?.unscheduleAll();
  });

  // ── Preview ──────────────────────────────────────────────────────────────────

  describe('previewNext', () => {
    it('returns N future times for a cron schedule', () => {
      scheduler = new Scheduler();
      const next = scheduler.previewNext({ kind: 'cron', cron: '* * * * *' }, { n: 3 });
      expect(next).toHaveLength(3);
      // Each result should be a valid ISO string in the future
      for (const t of next) {
        expect(new Date(t).getTime()).toBeGreaterThan(Date.now() - 70000);
      }
    });

    it('returns N times for an interval schedule', () => {
      scheduler = new Scheduler();
      const next = scheduler.previewNext({ kind: 'interval', everySec: 60 }, { n: 5 });
      expect(next).toHaveLength(5);
    });

    it('returns one time for a future one-shot', () => {
      scheduler = new Scheduler();
      const future = new Date(Date.now() + 3600 * 1000).toISOString();
      const next = scheduler.previewNext({ kind: 'one-shot', runAt: future });
      expect(next).toHaveLength(1);
    });

    it('returns empty for a past one-shot', () => {
      scheduler = new Scheduler();
      const past = new Date(Date.now() - 3600 * 1000).toISOString();
      const next = scheduler.previewNext({ kind: 'one-shot', runAt: past });
      expect(next).toHaveLength(0);
    });

    it('returns times in ascending order for cron', () => {
      scheduler = new Scheduler();
      const next = scheduler.previewNext({ kind: 'cron', cron: '0 * * * *' }, { n: 3 });
      for (let i = 1; i < next.length; i++) {
        expect(new Date(next[i]).getTime()).toBeGreaterThan(new Date(next[i - 1]).getTime());
      }
    });
  });

  // ── Validate ─────────────────────────────────────────────────────────────────

  describe('validateSchedule', () => {
    it('accepts a valid cron expression', () => {
      scheduler = new Scheduler();
      expect(scheduler.validateSchedule({ kind: 'cron', cron: '0 9 * * 1-5' }).ok).toBe(true);
    });

    it('rejects an invalid cron expression', () => {
      scheduler = new Scheduler();
      const r = scheduler.validateSchedule({ kind: 'cron', cron: 'not-a-cron' });
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    });

    it('accepts a valid interval schedule', () => {
      scheduler = new Scheduler();
      expect(scheduler.validateSchedule({ kind: 'interval', everySec: 60 }).ok).toBe(true);
    });

    it('accepts a valid one-shot schedule', () => {
      scheduler = new Scheduler();
      const future = new Date(Date.now() + 3600000).toISOString();
      expect(scheduler.validateSchedule({ kind: 'one-shot', runAt: future }).ok).toBe(true);
    });

    it('rejects a one-shot with invalid date', () => {
      scheduler = new Scheduler();
      const r = scheduler.validateSchedule({ kind: 'one-shot', runAt: 'not-a-date' });
      expect(r.ok).toBe(false);
    });
  });

  // ── Scheduling ────────────────────────────────────────────────────────────────

  it('schedules a cron job and emits tick events', async () => {
    scheduler = new Scheduler();
    const ticks: string[] = [];
    scheduler.on('tick', ({ jobId }) => ticks.push(jobId));

    const job = makeCronJob('every-second', '* * * * * *'); // croner supports seconds with 6-field cron
    scheduler.schedule(job);

    await new Promise((r) => setTimeout(r, 1500));
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks.every((id) => id === 'every-second')).toBe(true);
  });

  it('schedules an interval job and fires', async () => {
    scheduler = new Scheduler();
    const ticks: string[] = [];
    scheduler.on('tick', ({ jobId }) => ticks.push(jobId));

    scheduler.schedule(makeIntervalJob('fast-interval', 1));
    await new Promise((r) => setTimeout(r, 1500));
    expect(ticks.length).toBeGreaterThanOrEqual(1);
  });

  it('unschedule stops ticks', async () => {
    scheduler = new Scheduler();
    const ticks: string[] = [];
    scheduler.on('tick', ({ jobId }) => ticks.push(jobId));

    scheduler.schedule(makeIntervalJob('stoppable', 1));
    await new Promise((r) => setTimeout(r, 500));
    scheduler.unschedule('stoppable');
    const countAfterStop = ticks.length;
    await new Promise((r) => setTimeout(r, 1200));
    // Should not have fired more after unschedule (allow 1 in-flight)
    expect(ticks.length).toBeLessThanOrEqual(countAfterStop + 1);
  });

  it('disabled job is not scheduled', () => {
    scheduler = new Scheduler();
    const job: Job = { ...makeIntervalJob('disabled', 1), enabled: false };
    scheduler.schedule(job);
    expect((scheduler as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
  });

  it('schedule is idempotent — re-scheduling replaces existing', async () => {
    scheduler = new Scheduler();
    let ticks = 0;
    scheduler.on('tick', () => ticks++);

    const job = makeIntervalJob('redef', 1);
    scheduler.schedule(job);
    scheduler.schedule(job); // second call should replace
    await new Promise((r) => setTimeout(r, 500));
    // Entry count should be exactly 1
    expect((scheduler as unknown as { entries: Map<string, unknown> }).entries.size).toBe(1);
  });

  it('unscheduleAll stops all jobs', async () => {
    scheduler = new Scheduler();
    let ticks = 0;
    scheduler.on('tick', () => ticks++);

    for (let i = 0; i < 3; i++) {
      scheduler.schedule(makeIntervalJob(`job-${i}`, 1));
    }
    await new Promise((r) => setTimeout(r, 200));
    scheduler.unscheduleAll();
    const before = ticks;
    await new Promise((r) => setTimeout(r, 1200));
    expect(ticks).toBeLessThanOrEqual(before + 3); // at most a few in-flight
  });

  it('one-shot fires once then removes itself', async () => {
    scheduler = new Scheduler();
    const ticks: string[] = [];
    scheduler.on('tick', ({ jobId }) => ticks.push(jobId));

    const future = new Date(Date.now() + 300).toISOString();
    scheduler.schedule(makeOneShotJob('one-shot-job', future));
    await new Promise((r) => setTimeout(r, 800));
    expect(ticks.filter((id) => id === 'one-shot-job')).toHaveLength(1);
  });

  // ── safeSetTimeout: large delay does not fire immediately ────────────────────

  it('one-shot 30 days in the future does not fire with fake timers advanced 1 ms', () => {
    vi.useFakeTimers();
    try {
      scheduler = new Scheduler();
      const fired: string[] = [];
      scheduler.on('tick', ({ jobId }: { jobId: string }) => fired.push(jobId));

      const far = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      scheduler.schedule(makeOneShotJob('far-future', far));

      // Advance by 1 ms — with the bug the clamped timeout would already fire
      vi.advanceTimersByTime(1);

      expect(fired).toHaveLength(0);
    } finally {
      scheduler?.unscheduleAll();
      vi.useRealTimers();
    }
  });
});
