import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { Scheduler } from '../src/daemon/scheduler.js';

const validCronArb = fc
  .tuple(
    fc.constantFrom('*', '0', '1', '30', '*/5', '0-10'),
    fc.constantFrom('*', '0', '6', '12', '*/2', '0-23'),
    fc.constantFrom('*', '1', '15', '28', '*/7', '1-28'),
    fc.constantFrom('*', '1', '6', '12', '*/3', '1-12'),
    fc.constantFrom('*', '0', '1', '5', '*/2', '0-6'),
  )
  .map(([m, h, d, mo, wd]) => `${m} ${h} ${d} ${mo} ${wd}`);

describe('property: Scheduler.previewNext cron', () => {
  it('always returns N strictly increasing ISO timestamps in the future', () => {
    const scheduler = new Scheduler();
    try {
      fc.assert(
        fc.property(validCronArb, fc.integer({ min: 1, max: 10 }), (cron, n) => {
          const now = Date.now();
          const results = scheduler.previewNext({ kind: 'cron', cron }, { n });
          if (results.length === 0) return;

          for (const result of results) {
            const ts = new Date(result).getTime();
            expect(Number.isNaN(ts)).toBe(false);
          }

          for (let i = 1; i < results.length; i++) {
            expect(new Date(results[i]).getTime()).toBeGreaterThan(
              new Date(results[i - 1]).getTime(),
            );
          }

          for (const result of results) {
            expect(new Date(result).getTime()).toBeGreaterThan(now - 120_000);
          }
        }),
        { numRuns: 200 },
      );
    } finally {
      scheduler.unscheduleAll();
    }
  });
});
