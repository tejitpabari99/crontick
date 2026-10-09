import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner } from '../../src/daemon/runner.js';
import { Store } from '../../src/daemon/store.js';
import { TriggerDispatcher } from '../../src/daemon/trigger.js';
import { RelayManager } from '../../src/daemon/relay.js';
import { RelayGuard } from '../../src/daemon/relay-guard.js';
import { nullLogger } from '../../src/logger.js';
import type { Job } from '../../src/schemas/job.js';
import { FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';

// The engine dumps env + argv (the prompt is its last argv) to $OUT, so we can inspect a real run.
const DUMP = 'require("fs").writeFileSync(process.env.OUT,JSON.stringify({env:process.env,argv:process.argv.slice(1)}))';
const URL_ = 'https://smee.io/e2e-channel';
const SECRET = 's3cret';
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('webhook relay -> real run (end to end, fake SSE)', () => {
  let dir: string;
  let store: Store;
  let runner: Runner;
  let mgr: RelayManager;
  let prev: string | undefined;
  let push: (data: unknown) => void;
  let jobRow: Job;

  const sign = (body: unknown): string => 'sha256=' + createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');
  const send = async (body: unknown, extra: Record<string, unknown> = {}): Promise<void> => {
    push({ 'x-github-event': 'push', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': sign(body), 'x-arr-noise': 'zzz', body, ...extra });
    await wait(60);
  };
  const runsOf = (): ReturnType<Store['listRuns']> => store.listRuns({ jobId: jobRow.id });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crontick-wh-e2e-'));
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    prev = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    writeFakeEngineConfig(dir, { engines: { [FAKE_ENGINE_NAME]: { command: process.execPath, args: ['-e', DUMP], env: {} } } });
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
    runner = new Runner(undefined, undefined, undefined, 25);
    jobRow = { catchUp: false,
      id: randomUUID(), enabled: true,
      schedule: { kind: 'webhook', relay: URL_, secret: SECRET },
      action: { kind: 'prompt', prompt: 'review:', engine: FAKE_ENGINE_NAME, args: [], reuseSession: false, env: { OUT: join(dir, 'out.json') } },
      overlap: 'skip', retry: { max: 0, backoffSec: 30 },
    } as Job;
    store.upsertJob(jobRow);
    const enc = new TextEncoder();
    const fetchFn = (async (_u: string, init: RequestInit) => {
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
      (init.signal as AbortSignal).addEventListener('abort', () => { try { ctrl.error(new Error('aborted')); } catch { /* closed */ } });
      push = (d) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(d)}\n\n`));
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const guard = new RelayGuard({
      logger: nullLogger,
      getSecret: (id) => { const s = store.getJob(id)?.schedule; return s?.kind === 'webhook' ? s.secret : undefined; },
      recordRateLimited: (jobId, error, runId, at) => {
        if (runId === undefined) return store.recordSkippedRun(jobId, at, error).id;
        store.updateRun(runId, { error });
        return runId;
      },
    });
    mgr = new RelayManager({ dispatcher: new TriggerDispatcher({ store, runner, logger: nullLogger }), logger: nullLogger, fetch: fetchFn, guard: guard.guard });
    mgr.sync(store.listJobs());
    await wait(30);
  });
  afterEach(() => {
    mgr.stop();
    store.close();
    if (prev === undefined) delete process.env['CRONTICK_HOME'];
    else process.env['CRONTICK_HOME'] = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it('signed event starts a run with env, fenced untrusted prompt (backtick-safe), allowlisted headers and trigger_json', async () => {
    await send({ note: 'x ```` y', n: 1 });
    await wait(900);
    const runs = runsOf();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('success');
    const out = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf-8')) as { env: Record<string, string>; argv: string[] };
    expect(out.env['CRONTICK_TRIGGER']).toBe('webhook');
    expect(out.env['CRONTICK_EVENT_SOURCE']).toBe('relay');
    expect(out.env['CRONTICK_EVENT_ID']).toBeTruthy();
    const ev = JSON.parse(out.env['CRONTICK_EVENT']!) as { headers: Record<string, string>; body: unknown };
    expect(ev.body).toEqual({ note: 'x ```` y', n: 1 });
    expect(ev.headers['x-github-event']).toBe('push');
    expect(JSON.stringify(ev.headers)).not.toContain('zzz');
    expect(JSON.stringify(ev.headers)).not.toContain('sha256=');
    const prompt = out.argv.join(' ');
    expect(prompt).toContain('untrusted');
    expect(prompt).toContain('`````json'); // fence longer than the 4-backtick run in the payload
    expect(store.getRunTrigger(runs[0]!.id)).toMatchObject({ source: 'relay' });
  }, 15_000);

  it('unsigned or badly signed events start no run', async () => {
    await send({ a: 1 }, { 'x-hub-signature-256': 'sha256=deadbeef' });
    await send({ a: 2 }, { 'x-hub-signature-256': undefined });
    expect(runsOf()).toHaveLength(0);
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });

  it('repeated delivery id fires once; 11th distinct event in a minute records one RATE_LIMITED skipped run', async () => {
    const dup = { 'x-github-delivery': 'same-id' };
    await send({ a: 1 }, dup);
    await send({ a: 1 }, dup);
    await wait(900);
    expect(runsOf().filter((r) => r.status === 'success')).toHaveLength(1);
    for (let i = 0; i < 12; i++) await send({ i });
    const limited = runsOf().filter((r) => r.error?.startsWith('RATE_LIMITED'));
    expect(limited).toHaveLength(1);
    expect(limited[0]!.status).toBe('skipped');
  }, 30_000);

  it('startup/reload with a webhook job records no missed or fired runs', () => {
    expect(runsOf()).toHaveLength(0);
    mgr.sync(store.listJobs());
    expect(runsOf()).toHaveLength(0);
  });
});
