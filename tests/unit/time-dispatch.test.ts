import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/daemon/store.js';
import { dispatchTimeRun } from '../../src/daemon/time-dispatch.js';
import { createLogger } from '../../src/logger.js';
import type { Job } from '../../src/schemas/job.js';

function job(id: string, enabled = true): Job {
  return {
    catchUp: false,
    id,
    enabled,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: { kind: 'exec', command: 'true', args: [] },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
  } as unknown as Job;
}

describe('dispatchTimeRun', () => {
  let dir: string;
  let store: Store;
  const logger = createLogger({ level: 'error', sink: () => {} });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crontick-test-'));
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('inserts a run at plannedAt, advances the watermark, and runs with ctx', () => {
    vi.spyOn(store, 'getJob').mockReturnValue(job('a'));
    const run = vi.fn().mockResolvedValue(undefined);
    const ctx = { env: { CRONTICK_TRIGGER: 'catch-up' } };
    const res = dispatchTimeRun({ store, runner: { run } as never, logger }, 'a', new Date(5000), ctx);
    expect(res).toEqual({ runId: expect.any(String) });
    const runs = store.listRuns({ jobId: 'a' });
    expect(runs).toHaveLength(1);
    expect(runs[0].startedAt).toBe(5000);
    expect(store.getScheduleState('a')?.lastTickAt).toBe(5000);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), runs[0].id, store, ctx);
  });

  it('returns skipped and does not run when job is missing or disabled', () => {
    const run = vi.fn();
    const deps = { store, runner: { run } as never, logger };
    expect(dispatchTimeRun(deps, 'nope', new Date(1))).toEqual({ skipped: 'disabled' });
    vi.spyOn(store, 'getJob').mockReturnValue(job('b', false));
    expect(dispatchTimeRun(deps, 'b', new Date(1))).toEqual({ skipped: 'disabled' });
    expect(run).not.toHaveBeenCalled();
  });

  it('logs runner rejection without throwing', async () => {
    vi.spyOn(store, 'getJob').mockReturnValue(job('c'));
    const errs: string[] = [];
    const lg = createLogger({ level: 'error', sink: (e) => errs.push(e.message) });
    const run = vi.fn().mockRejectedValue(new Error('boom'));
    dispatchTimeRun({ store, runner: { run } as never, logger: lg }, 'c', new Date(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(errs).toContain('Runner error');
  });
});
