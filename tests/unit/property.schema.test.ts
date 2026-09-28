import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { JobSchema } from '../../src/schemas/job.js';

// `id` is now an immutable GUID (see docs/concepts/jobs.md#identity); the
// human-friendly, kebab-case identifier these generators previously called
// "id" is `alias`.
const validAliasArb = fc
  .tuple(
    fc.constantFrom('job', 'task', 'sync', 'backup', 'daily'),
    fc.array(fc.constantFrom('a1', 'b2', 'cleanup', 'nightly', 'run'), { maxLength: 3 }),
  )
  .map(([head, tail]) => [head, ...tail].join('-').slice(0, 30));

const validJobArb = fc.record({
  alias: validAliasArb,
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
    kind: fc.constant('prompt' as const),
    prompt: fc.string({ minLength: 1, maxLength: 100 }),
    engine: fc.constantFrom('copilot' as const, 'agency' as const, 'openai' as const),
    args: fc.array(fc.string({ maxLength: 20 }), { maxLength: 5 }),
  }),
});

const invalidJobArb = fc.oneof(
  fc.record({
    alias: fc.constantFrom('Invalid', 'BAD-ID', 'Upper-Case'),
    schedule: fc.constant({ kind: 'cron', cron: '* * * * *' }),
    action: fc.constant({ kind: 'exec', command: 'echo', args: [] }),
  }),
  fc.constant({ schedule: { kind: 'bogus' } }),
  fc.constant({
    schedule: { kind: 'bogus' },
    action: { kind: 'exec', command: 'echo', args: [] },
  }),
  fc.constant({
    schedule: { kind: 'interval', everySec: -1 },
    action: { kind: 'exec', command: 'echo', args: [] },
  }),
  fc.constant({
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: { kind: 'script', script: 'echo hi', engine: 'copilot' },
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

  it('applies prompt defaults and strict mode-specific validation', () => {
    const parsed = JobSchema.parse({
      alias: 'valid-id',
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'prompt', prompt: 'hello' },
    });

    expect(parsed.action).toMatchObject({
      kind: 'prompt',
      args: [],
      reuseSession: false,
    });
    expect(JobSchema.safeParse({
      alias: 'valid-id',
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'prompt', prompt: 'hello', promptFile: 'x.txt' },
    }).success).toBe(false);
  });

  it('requires overlap skip when a prompt reuses a session', () => {
    const input = {
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'prompt', prompt: 'hello', reuseSession: true },
    };
    expect(JobSchema.parse(input).overlap).toBe('skip');
    for (const overlap of ['queue', 'cancel-previous']) {
      const result = JobSchema.safeParse({ ...input, overlap });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['overlap'], message: expect.stringContaining('reuseSession') }),
      ]));
    }
    expect(JobSchema.safeParse({ ...input, action: { ...input.action, reuseSession: false }, overlap: 'queue' }).success).toBe(true);
  });
});
