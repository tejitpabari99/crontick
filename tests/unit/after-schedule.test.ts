import { describe, it, expect, vi } from 'vitest';
import { Scheduler } from '../../src/daemon/scheduler.js';
import { ScheduleSchema, isTimeSchedule } from '../../src/schemas/job.js';
import type { Job, Schedule } from '../../src/schemas/job.js';

const UP = '11111111-1111-4111-8111-111111111111';
const after: Schedule = { kind: 'after', jobId: UP, status: 'success' };

function afterJob(): Job {
  return { catchUp: false,
    id: '22222222-2222-4222-8222-222222222222',
    enabled: true,
    schedule: after,
    action: { kind: 'prompt', prompt: 'noop', args: [], reuseSession: false },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
  };
}

describe('after schedule schema', () => {
  it.each(['success', 'failure', 'any'])('accepts status %s', (status) => {
    expect(ScheduleSchema.safeParse({ kind: 'after', jobId: UP, status }).success).toBe(true);
  });
  it('rejects unknown status', () => {
    expect(ScheduleSchema.safeParse({ kind: 'after', jobId: UP, status: 'bogus' }).success).toBe(false);
  });
  it('rejects non-GUID jobId (alias)', () => {
    expect(ScheduleSchema.safeParse({ kind: 'after', jobId: 'my-alias', status: 'any' }).success).toBe(false);
  });
  it('isTimeSchedule is false only for after', () => {
    expect(isTimeSchedule(after)).toBe(false);
    expect(isTimeSchedule({ kind: 'cron', cron: '* * * * *' })).toBe(true);
    expect(isTimeSchedule({ kind: 'interval', everySec: 5 })).toBe(true);
    expect(isTimeSchedule({ kind: 'one-shot', runAt: '2099-01-01T00:00' })).toBe(true);
  });
});

describe('Scheduler with after schedule', () => {
  it('schedule() no-ops with a debug log', () => {
    const debug = vi.fn();
    const logger = { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
    const s = new Scheduler(logger as never);
    s.schedule(afterJob());
    expect(debug).toHaveBeenCalled();
    expect((s as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
    s.unscheduleAll();
  });
  it('previewNext returns []', () => {
    expect(new Scheduler().previewNext(after)).toEqual([]);
  });
  it('enumerateFiresBetween returns no fires', () => {
    expect(new Scheduler().enumerateFiresBetween(after, 0, 10_000_000)).toEqual({ fires: [], capped: false });
  });
  it('validateSchedule is ok for after', () => {
    expect(new Scheduler().validateSchedule(after)).toEqual({ ok: true });
  });
});
