import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { Scheduler } from '../src/daemon/scheduler.js';

function makeOneShotJob(id: string, runAt: string) {
  return {
    id,
    enabled: true,
    schedule: { kind: 'one-shot' as const, runAt },
    action: { kind: 'exec' as const, command: 'echo', args: [] },
    catchup: 'skip' as const,
    overlap: 'skip' as const,
    retry: { max: 0, backoffSec: 30 },
    budgets: { maxRunsPerDay: null, maxTokensPerRun: null },
  };
}

describe('property: safeSetTimeout via Scheduler one-shot', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('large delays (>2^31ms) do not fire with fake timers advanced by 1ms', () => {
    const delays = fc.sample(fc.bigInt({ min: 2_147_483_648n, max: 8_589_934_591n }).map(Number), 20);

    for (const delayMs of delays) {
      vi.useFakeTimers();
      const scheduler = new Scheduler();
      const fired: string[] = [];
      scheduler.on('tick', ({ jobId }: { jobId: string }) => fired.push(jobId));

      try {
        const future = new Date(Date.now() + delayMs).toISOString();
        scheduler.schedule(makeOneShotJob('prop-test', future));
        vi.advanceTimersByTime(1);
        expect(fired).toHaveLength(0);
      } finally {
        scheduler.unscheduleAll();
        vi.useRealTimers();
      }
    }
  });

  it('small delays (50..100ms) fire after being advanced past the delay', () => {
    const delays = fc.sample(fc.integer({ min: 50, max: 100 }), 20);

    for (const delayMs of delays) {
      vi.useFakeTimers();
      const scheduler = new Scheduler();
      const fired: string[] = [];
      scheduler.on('tick', ({ jobId }: { jobId: string }) => fired.push(jobId));

      try {
        const future = new Date(Date.now() + delayMs).toISOString();
        scheduler.schedule(makeOneShotJob('small-delay', future));
        vi.advanceTimersByTime(delayMs + 10);
        expect(fired.length).toBeGreaterThanOrEqual(1);
      } finally {
        scheduler.unscheduleAll();
        vi.useRealTimers();
      }
    }
  });
});
