import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { JobSchema } from '../src/schemas/job.js';

const validIdArb = fc
  .tuple(
    fc.constantFrom('job', 'task', 'sync', 'backup', 'daily'),
    fc.array(fc.constantFrom('a1', 'b2', 'cleanup', 'nightly', 'run'), { maxLength: 3 }),
  )
  .map(([head, tail]) => [head, ...tail].join('-').slice(0, 30));

const validJobArb = fc.record({
  id: validIdArb,
  enabled: fc.boolean(),
  schedule: fc.oneof(
    fc.record({
      kind: fc.constant('cron' as const),
      cron: fc.constantFrom('* * * * *', '0 * * * *', '0 0 * * *'),
    }),
    fc.record({
      kind: fc.constant('interval' as const),
      everySec: fc.integer({ min: 1, max: 3600 }),
    }),
  ),
  action: fc.record({
    kind: fc.constant('exec' as const),
    command: fc.constantFrom('echo', 'node', 'pwsh'),
    args: fc.array(fc.string({ maxLength: 20 }), { maxLength: 5 }),
  }),
});

const invalidJobArb = fc.oneof(
  fc.record({
    id: fc.constantFrom('Invalid', 'BAD-ID', 'Upper-Case'),
    schedule: fc.constant({ kind: 'cron', cron: '* * * * *' }),
    action: fc.constant({ kind: 'exec', command: 'echo', args: [] }),
  }),
  fc.constant({}),
  fc.constant({ id: 'valid-id' }),
  fc.constant({
    id: 'valid-id',
    schedule: { kind: 'bogus' },
    action: { kind: 'exec', command: 'echo', args: [] },
  }),
  fc.constant({
    id: 'valid-id',
    schedule: { kind: 'interval', everySec: -1 },
    action: { kind: 'exec', command: 'echo', args: [] },
  }),
);

describe('property: JobSchema', () => {
  it('accepts all valid job shapes', () => {
    fc.assert(
      fc.property(validJobArb, (job) => {
        const result = JobSchema.safeParse(job);
        expect(result.success).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('rejects all invalid job shapes', () => {
    fc.assert(
      fc.property(invalidJobArb, (bad) => {
        const result = JobSchema.safeParse(bad);
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
