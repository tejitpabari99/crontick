import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '../../src/daemon/runner.js';
import { buildRunEnv } from '../../src/daemon/run-context.js';
import { Store } from '../../src/daemon/store.js';
import type { Job } from '../../src/schemas/job.js';
import { FAKE_ENGINE_CONFIG, FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';

function job(id: string, code: string, extra: Partial<Job> = {}): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: { kind: 'prompt', prompt: code, engine: FAKE_ENGINE_NAME, args: [], reuseSession: false },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
    ...extra,
  } as Job;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('buildRunEnv', () => {
  it('merges process < prompt < envFile < action.env < ctx.env (ctx last)', () => {
    const env = buildRunEnv({ A: 'p', B: 'p' }, { B: 'f', C: 'f' }, { C: 'a', D: 'a', CRONTICK_TRIGGER: 'user' }, { CRONTICK_TRIGGER: 'after' });
    expect(env['A']).toBe('p');
    expect(env['B']).toBe('f');
    expect(env['C']).toBe('a');
    expect(env['D']).toBe('a');
    expect(env['CRONTICK_TRIGGER']).toBe('after');
    expect(env['PATH']).toBe(process.env['PATH']);
  });
});

describe('Runner.onRunComplete', () => {
  let dir: string;
  let store: Store;
  let runner: Runner;
  let previousHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crontick-complete-'));
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

  it('emits once per terminal run, with final status, after retries', async () => {
    const j = job('hk-retry', 'process.exit(1)', { retry: { max: 2, backoffSec: 0 } });
    store.upsertJob(j);
    const events: Array<{ jobId: string; runId: string; status: string }> = [];
    runner.onRunComplete((e) => { events.push(e); });
    const run = store.insertRun(j.id);
    await runner.run(j, run.id, store);
    await flush();
    expect(events).toEqual([expect.objectContaining({ jobId: j.id, runId: run.id, status: 'failed' })]);
    expect(events).toHaveLength(1);
  });

  it('emits for success (early-return path of failure bookkeeping)', async () => {
    const j = job('hk-ok', 'process.exit(0)');
    store.upsertJob(j);
    const statuses: string[] = [];
    runner.onRunComplete((e) => { statuses.push(e.status); });
    await runner.run(j, store.insertRun(j.id).id, store);
    await flush();
    expect(statuses).toEqual(['success']);
  });

  it('never emits for overlap-skipped runs', async () => {
    const j = job('hk-skip', 'setTimeout(()=>{},300)');
    store.upsertJob(j);
    const statuses: string[] = [];
    runner.onRunComplete((e) => { statuses.push(e.status); });
    const first = runner.run(j, store.insertRun(j.id).id, store);
    await flush();
    await runner.run(j, store.insertRun(j.id).id, store);
    await first;
    await flush();
    expect(statuses).toEqual(['success']);
  });

  it('a throwing listener does not break other listeners or the runner', async () => {
    const j = job('hk-throw', 'process.exit(0)');
    store.upsertJob(j);
    const seen: string[] = [];
    runner.onRunComplete(() => { throw new Error('boom'); });
    runner.onRunComplete(() => Promise.reject(new Error('async boom')));
    runner.onRunComplete((e) => { seen.push(e.status); });
    await expect(runner.run(j, store.insertRun(j.id).id, store)).resolves.toBeUndefined();
    await flush();
    expect(seen).toEqual(['success']);
  });

  it('emits after auto-disable bookkeeping', async () => {
    const r = new Runner(undefined, undefined, undefined, undefined, undefined, undefined, undefined, 1);
    const j = job('hk-dis', 'process.exit(1)');
    store.upsertJob(j);
    let enabledAtEmit: boolean | undefined;
    r.onRunComplete(() => { enabledAtEmit = store.getJob(j.id)?.enabled; });
    await r.run(j, store.insertRun(j.id).id, store);
    await flush();
    expect(enabledAtEmit).toBe(false);
  });

  it('emits for reconciled outcomes via recordRunOutcome', async () => {
    const j = job('hk-rec', 'process.exit(0)');
    store.upsertJob(j);
    const run = store.insertRun(j.id);
    const statuses: string[] = [];
    runner.onRunComplete((e) => { statuses.push(e.status); });
    runner.recordRunOutcome(j.id, run.id, { status: 'canceled' }, store);
    await flush();
    expect(statuses).toEqual(['canceled']);
  });

  it('injects ctx.env (above action.env) and prompt suffix; queued runs keep ctx', async () => {
    const out = join(dir, 'env-out.txt');
    const code = `require("fs").writeFileSync(${JSON.stringify(out)}, process.env.CRONTICK_TRIGGER + "|" + process.env.MINE)`;
    const j = job('hk-env', code, {
      overlap: 'queue',
      action: { kind: 'prompt', prompt: code, engine: FAKE_ENGINE_NAME, args: [], reuseSession: false, env: { CRONTICK_TRIGGER: 'spoof', MINE: 'x' } },
    } as Partial<Job>);
    store.upsertJob(j);
    const blocker = job('hk-env', 'setTimeout(()=>{},200)', { overlap: 'queue' });
    const r1 = store.insertRun(j.id);
    const r2 = store.insertRun(j.id);
    const p1 = runner.run(blocker, r1.id, store);
    await flush();
    const p2 = runner.run(j, r2.id, store, { env: { CRONTICK_TRIGGER: 'after' } });
    await Promise.all([p1, p2]);
    expect(readFileSync(out, 'utf8')).toBe('after|x');
  });

  it('promptSuffix is appended to the prompt', async () => {
    const out = join(dir, 'suffix-out.txt');
    const j = job('hk-suffix', `require("fs").writeFileSync(${JSON.stringify(out)}, "a")`);
    store.upsertJob(j);
    const run = store.insertRun(j.id);
    await runner.run(j, run.id, store, { promptSuffix: `;require("fs").appendFileSync(${JSON.stringify(out)}, "b")` });
    expect(readFileSync(out, 'utf8')).toBe('ab');
  });
});
