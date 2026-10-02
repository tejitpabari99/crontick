import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '../../src/daemon/runner.js';
import { Store } from '../../src/daemon/store.js';
import type { Job } from '../../src/schemas/job.js';
import { MAX_CONSECUTIVE_FAILURES } from '../../src/constants/daemon.js';
import { FAKE_ENGINE_CONFIG, FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';

function job(id: string, code: string): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: { kind: 'prompt', prompt: code, engine: FAKE_ENGINE_NAME, args: [], reuseSession: false },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
  };
}

describe('Runner auto-disable after consecutive failures', () => {
  let dir: string;
  let store: Store;
  let runner: Runner;
  let previousHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crontick-autodisable-'));
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    previousHome = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    writeFakeEngineConfig(dir, { engines: { [FAKE_ENGINE_NAME]: FAKE_ENGINE_CONFIG } });
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
    runner = new Runner();
  });

  afterEach(() => {
    store.close();
    if (previousHome === undefined) delete process.env['CRONTICK_HOME'];
    else process.env['CRONTICK_HOME'] = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });

  async function runOnce(j: Job): Promise<string> {
    const run = store.insertRun(j.id);
    await runner.run(store.getJob(j.id) ?? j, run.id, store);
    return run.id;
  }

  it('disables the job on the Nth consecutive failure and says so on the run', async () => {
    const j = job('ad-fail', 'process.exit(1)');
    store.upsertJob(j);
    for (let i = 1; i < MAX_CONSECUTIVE_FAILURES; i++) {
      await runOnce(j);
      expect(store.getJob(j.id)?.enabled).toBe(true);
      expect(store.getConsecutiveFailures(j.id)).toBe(i);
    }
    const lastRunId = await runOnce(j);
    expect(store.getJob(j.id)?.enabled).toBe(false);
    const last = store.getRun(lastRunId)!;
    expect(last.status).toBe('failed');
    expect(last.error).toContain('AUTO_DISABLED');
    expect(last.error).toContain(`${MAX_CONSECUTIVE_FAILURES} consecutive failed runs`);
  });

  it('a success resets the counter so failures must be consecutive', async () => {
    const bad = job('ad-reset', 'process.exit(1)');
    store.upsertJob(bad);
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) await runOnce(bad);
    store.upsertJob({ ...bad, action: { ...bad.action, prompt: 'process.exit(0)' } });
    await runOnce(bad);
    expect(store.getConsecutiveFailures(bad.id)).toBe(0);
    store.upsertJob(bad);
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) await runOnce(bad);
    expect(store.getJob(bad.id)?.enabled).toBe(true);
  });

  it('resetConsecutiveFailures restarts the count', async () => {
    const j = job('ad-skip', 'process.exit(1)');
    store.upsertJob(j);
    await runOnce(j);
    await runOnce(j);
    expect(store.getConsecutiveFailures(j.id)).toBe(2);
    store.resetConsecutiveFailures(j.id);
    expect(store.getConsecutiveFailures(j.id)).toBe(0);
    await runOnce(j);
    expect(store.getJob(j.id)?.enabled).toBe(true);
  });

  it('deleting a job clears its failure count', async () => {
    const j = job('ad-delete', 'process.exit(1)');
    store.upsertJob(j);
    await runOnce(j);
    store.deleteJobAndRuns(j.id);
    expect(store.getConsecutiveFailures(j.id)).toBe(0);
  });
});
