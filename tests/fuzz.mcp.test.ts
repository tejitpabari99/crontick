import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { JobSchema, ScheduleSchema } from '../src/schemas/job.js';

describe('fuzz: MCP tool input validation', () => {
  it('crontick_schedule_validate: random inputs are either valid or produce structured error', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant({}),
          fc.constant({ kind: 'cron' }),
          fc.constant({ kind: 'cron', cron: '' }),
          fc.record({
            kind: fc.constantFrom('cron', 'interval', 'one-shot', 'bogus'),
            cron: fc.option(fc.string(), { nil: undefined }),
            everySec: fc.option(fc.integer(), { nil: undefined }),
            runAt: fc.option(fc.string(), { nil: undefined }),
          }),
          fc.dictionary(fc.string({ maxLength: 10 }), fc.oneof(fc.string(), fc.integer()), { maxKeys: 5 }),
        ),
        (input) => {
          const result = ScheduleSchema.safeParse(input);
          expect(typeof result.success).toBe('boolean');
          if (!result.success) {
            expect(result.error).toBeTruthy();
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('crontick_job_create: random inputs never crash validation, always return parse result', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant({}),
          fc.dictionary(
            fc.string({ maxLength: 15 }),
            fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null), fc.constant(undefined)),
            { maxKeys: 15 },
          ),
          fc.constant({
            id: 'valid-id',
            schedule: { kind: 'cron', cron: '* * * * *' },
            action: { kind: 'exec', command: 'echo', args: [] },
          }),
        ),
        (input) => {
          const result = JobSchema.safeParse(input);
          expect(typeof result.success).toBe('boolean');
          if (!result.success) {
            expect(result.error).toBeTruthy();
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
