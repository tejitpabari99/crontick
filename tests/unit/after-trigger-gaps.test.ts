import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '../../src/daemon/runner.js';
import { Store } from '../../src/daemon/store.js';
import { TriggerDispatcher, registerAfterTrigger } from '../../src/daemon/trigger.js';
import { nullLogger } from '../../src/logger.js';
import type { Job } from '../../src/schemas/job.js';
import { FAKE_ENGINE_CONFIG, FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';

function job(code: string, extra: Partial<Job> = {}): Job {
  return {
    id: randomUUID(),
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: { kind: 'prompt', prompt: code, engine: FAKE_ENGINE_NAME, args: [], reuseSession: false },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
    ...extra,
  } as Job;
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('after-trigger gap coverage', () => {
  let dir: string;
  let store: Store;
  let runner: Runner;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crontick-after-gap-'));
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    prev = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    writeFakeEngineConfig(dir, { engines: { [FAKE_ENGINE_NAME]: FAKE_ENGINE_CONFIG } });
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
    runner = new Runner(undefined, undefined, undefined, 25);
    registerAfterTrigger({
      runner, store, logger: nullLogger,
      dispatcher: new TriggerDispatcher({ store, runner, logger: nullLogger }),
    });
  });
  afterEach(() => {
    store.close();
    if (prev === undefined) delete process.env['CRONTICK_HOME'];
    else process.env['CRONTICK_HOME'] = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it('an adopted upstream run exiting after restart fires its dependent exactly once', async () => {
    const up = job('0');
    const down = job('0', { schedule: { kind: 'after', jobId: up.id, status: 'any' } });
    store.upsertJob(up);
    store.upsertJob(down);
    const child = nodeSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
    const run = store.insertRun(up.id);
    store.updateRun(run.id, { status: 'running', pid: child.pid!, sessionId: 'sess-1' });
    mkdirSync(join(dir, 'runs'), { recursive: true });
    writeFileSync(join(dir, 'runs', `${run.id}.claude-hook.json`), JSON.stringify({ exitStatus: 1, sessionId: 'sess-1' }));
    runner.adoptRun(up.id, run.id, child.pid!, store);
    await wait(100);
    expect(store.listRuns({ jobId: down.id })).toHaveLength(0); // still alive: nothing fires
    child.kill();
    await wait(700);
    expect(store.getRun(run.id)!.status).toBe('failed'); // marker -> failed
    await wait(300);
    expect(store.listRuns({ jobId: down.id })).toHaveLength(1);
    expect(store.getRunTrigger(store.listRuns({ jobId: down.id })[0]!.id)).toEqual({ kind: 'after', upstream: run.id });
  }, 15_000);

  describe('downstream overlap policies', () => {
    const slow = 'setTimeout(() => {}, 400)';
    async function fireTwice(down: Job, up: Job): Promise<void> {
      store.upsertJob(up);
      store.upsertJob(down);
      runner.recordRunOutcome(up.id, store.insertRun(up.id).id, { status: 'success' }, store);
      await wait(100);
      runner.recordRunOutcome(up.id, store.insertRun(up.id).id, { status: 'success' }, store);
      await wait(1500);
    }

    it('skip: second trigger is recorded as a visible skipped run', async () => {
      const up = job('0');
      const down = job(slow, { overlap: 'skip', schedule: { kind: 'after', jobId: up.id, status: 'success' } });
      await fireTwice(down, up);
      const statuses = store.listRuns({ jobId: down.id }).map((r) => r.status).sort();
      expect(statuses).toEqual(['skipped', 'success']);
    }, 15_000);

    it('queue: both triggers run, none dropped', async () => {
      const up = job('0');
      const down = job(slow, { overlap: 'queue', schedule: { kind: 'after', jobId: up.id, status: 'success' } });
      await fireTwice(down, up);
      const statuses = store.listRuns({ jobId: down.id }).map((r) => r.status);
      expect(statuses).toEqual(['success', 'success']);
    }, 15_000);

    it('cancel-previous: first run is canceled, second completes', async () => {
      const up = job('0');
      const down = job(slow, { overlap: 'cancel-previous', schedule: { kind: 'after', jobId: up.id, status: 'success' } });
      await fireTwice(down, up);
      const statuses = store.listRuns({ jobId: down.id }).map((r) => r.status).sort();
      expect(statuses).toEqual(['canceled', 'success']);
    }, 15_000);
  });
});
