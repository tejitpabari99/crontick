import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '../../src/daemon/runner.js';
import { Store } from '../../src/daemon/store.js';
import type { Job } from '../../src/schemas/job.js';
import { DEFAULT_MAX_CONSECUTIVE_FAILURES as MAX_CONSECUTIVE_FAILURES } from '../../src/constants/daemon.js';
import { loadConfig } from '../../src/config.js';
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

  it('auto-disable message points at the real re-enable command', async () => {
    const j = job('ad-msg', 'process.exit(1)');
    store.upsertJob(j);
    let id = '';
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) id = await runOnce(j);
    const error = store.getRun(id)!.error!;
    expect(error).toContain('crontick jobs update <id|alias> --enable');
    expect(error).not.toContain('(crontick jobs enable)');
  });

  describe('maxConsecutiveFailures config', () => {
    it('defaults to 3', () => {
      expect(loadConfig().maxConsecutiveFailures).toBe(3);
    });

    it('honours a custom value from config.json', async () => {
      writeFakeEngineConfig(dir, { engines: { [FAKE_ENGINE_NAME]: FAKE_ENGINE_CONFIG }, maxConsecutiveFailures: 2 });
      expect(loadConfig().maxConsecutiveFailures).toBe(2);
      const j = job('ad-custom', 'process.exit(1)');
      store.upsertJob(j);
      await runOnce(j);
      expect(store.getJob(j.id)?.enabled).toBe(true);
      const lastRunId = await runOnce(j);
      expect(store.getJob(j.id)?.enabled).toBe(false);
      expect(store.getRun(lastRunId)!.error).toContain('2 consecutive failed runs');
    });

    it('accepts an injected limit and rejects non-positive-integer config values', () => {
      for (const bad of [0, -1, 1.5]) {
        writeFakeEngineConfig(dir, { engines: { [FAKE_ENGINE_NAME]: FAKE_ENGINE_CONFIG }, maxConsecutiveFailures: bad });
        expect(() => loadConfig()).toThrow();
      }
    });
  });

  describe('adopted and reconciled runs', () => {
    const SESSION = 'sess-1';

    function writeMarker(runId: string, exitStatus: number): void {
      mkdirSync(join(dir, 'runs'), { recursive: true });
      writeFileSync(join(dir, 'runs', `${runId}.claude-hook.json`), JSON.stringify({ exitStatus, sessionId: SESSION }));
    }

    async function adoptAndExit(j: Job, exitStatus: number): Promise<string> {
      const child = nodeSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
      const run = store.insertRun(j.id);
      store.updateRun(run.id, { status: 'running', pid: child.pid!, sessionId: SESSION });
      writeMarker(run.id, exitStatus);
      const adopter = new Runner(undefined, undefined, undefined, 25);
      adopter.adoptRun(j.id, run.id, child.pid!, store);
      child.kill();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && store.getRun(run.id)!.status === 'running') {
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 25));
      return run.id;
    }

    function reconcile(j: Job, exitStatus: number): string {
      const run = store.insertRun(j.id);
      store.updateRun(run.id, { status: 'running', pid: 999_999_999, sessionId: SESSION });
      writeMarker(run.id, exitStatus);
      const result = store.reconcileOrphanRuns();
      expect(result.finalized.map((f) => f.runId)).toContain(run.id);
      for (const f of result.finalized) runner.recordRunOutcome(f.jobId, f.runId, { status: f.status, error: f.error }, store);
      return run.id;
    }

    it('adopted failures count and auto-disable', async () => {
      const j = job('ad-adopt-fail', 'process.exit(0)');
      store.upsertJob(j);
      let id = '';
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) id = await adoptAndExit(j, 1);
      expect(store.getRun(id)!.status).toBe('failed');
      expect(store.getJob(j.id)?.enabled).toBe(false);
      expect(store.getRun(id)!.error).toContain('AUTO_DISABLED');
    }, 20_000);

    it('adopted success resets the count', async () => {
      const j = job('ad-adopt-ok', 'process.exit(0)');
      store.upsertJob(j);
      await adoptAndExit(j, 1);
      expect(store.getConsecutiveFailures(j.id)).toBe(1);
      await adoptAndExit(j, 0);
      expect(store.getConsecutiveFailures(j.id)).toBe(0);
    }, 20_000);

    it('reconciled failures count and auto-disable', () => {
      const j = job('ad-rec-fail', 'process.exit(0)');
      store.upsertJob(j);
      let id = '';
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) id = reconcile(j, 2);
      expect(store.getRun(id)!.status).toBe('failed');
      expect(store.getJob(j.id)?.enabled).toBe(false);
      expect(store.getRun(id)!.error).toContain('AUTO_DISABLED');
    });

    it('reconciled success resets the count', () => {
      const j = job('ad-rec-ok', 'process.exit(0)');
      store.upsertJob(j);
      reconcile(j, 2);
      expect(store.getConsecutiveFailures(j.id)).toBe(1);
      reconcile(j, 0);
      expect(store.getConsecutiveFailures(j.id)).toBe(0);
    });
  });
});
