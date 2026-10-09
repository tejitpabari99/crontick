import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../../src/daemon/scheduler.js';
import { startApiHarness, type ApiHarness } from '../helpers/api-harness.js';

function intervalJob(id: string) {
  return {
    id,
    enabled: true,
    schedule: { kind: 'interval' as const, everySec: 10 },
    action: { kind: 'prompt' as const, prompt: 'noop', args: [], reuseSession: false },
    overlap: 'skip' as const,
    retry: { max: 0, backoffSec: 30 },
  };
}

describe('Scheduler pause/resume', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('emits tick normally when not paused', () => {
    vi.useFakeTimers();
    const s = new Scheduler();
    const ticks: string[] = [];
    s.on('tick', (e: { jobId: string }) => ticks.push(e.jobId));
    s.schedule(intervalJob('a') as never);
    vi.advanceTimersByTime(10_000);
    expect(ticks).toEqual(['a']);
    s.unscheduleAll();
  });

  it('while paused emits paused-tick (not tick); resume restores tick', () => {
    vi.useFakeTimers();
    const s = new Scheduler();
    const ticks: string[] = [];
    const paused: string[] = [];
    s.on('tick', (e: { jobId: string }) => ticks.push(e.jobId));
    s.on('paused-tick', (e: { jobId: string }) => paused.push(e.jobId));
    s.schedule(intervalJob('a') as never);
    expect(s.isPaused()).toBe(false);
    s.pause();
    expect(s.isPaused()).toBe(true);
    vi.advanceTimersByTime(20_000);
    expect(ticks).toEqual([]);
    expect(paused).toEqual(['a', 'a']);
    s.resume();
    expect(s.isPaused()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(ticks).toEqual(['a']);
    expect(paused).toHaveLength(2);
    s.unscheduleAll();
  });
});

describe('daemon pause/resume API', () => {
  let h: ApiHarness;
  beforeAll(async () => { h = await startApiHarness('daemon-pause'); });
  afterAll(async () => { await h.close(); });

  it('status shows paused, pause/resume toggle and are idempotent', async () => {
    expect((await h.call('GET', '/api/daemon/status')).data.paused).toBe(false);
    const p = await h.call('POST', '/api/daemon/pause');
    expect(p.status).toBe(200);
    expect(p.data).toEqual({ ok: true, paused: true });
    expect((await h.call('POST', '/api/daemon/pause')).data.paused).toBe(true);
    expect((await h.call('GET', '/api/daemon/status')).data.paused).toBe(true);
    const r = await h.call('POST', '/api/daemon/resume');
    expect(r.data).toEqual({ ok: true, paused: false });
    expect((await h.call('GET', '/api/daemon/status')).data.paused).toBe(false);
  });
});

describe('Store.recordSkippedRun', () => {
  it('records a terminal skipped run', async () => {
    const h = await startApiHarness('daemon-pause-store');
    try {
      const created = await h.call('POST', '/api/jobs', {
        description: 'x', enabled: true, schedule: { kind: 'interval', everySec: 60 },
        action: { kind: 'prompt', prompt: 'hi', args: [], reuseSession: false },
      });
      const jobId = created.data.id as string;
      const run = h.store.recordSkippedRun(jobId, 1234, 'paused');
      expect(run.status).toBe('skipped');
      const got = h.store.getRun(run.id);
      expect(got?.status).toBe('skipped');
      expect(got?.endedAt).toBe(1234);
      expect(got?.error).toContain('paused');
    } finally { await h.close(); }
  });
});
