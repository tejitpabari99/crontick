import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TriggerDispatcher } from '../../src/daemon/trigger.js';
import { RelayManager } from '../../src/daemon/relay.js';
import type { TriggerRequest } from '../../src/daemon/trigger.js';
import type { Job } from '../../src/schemas/job.js';
import { createLogger } from '../../src/logger.js';

const enc = new TextEncoder();
const A = 'https://smee.io/aaa';
const B = 'https://smee.io/bbb';

interface Stream { url: string; push(s: string): void; end(): void; signal: AbortSignal }

function setup(opts: { guardDrop?: boolean } = {}) {
  const streams: Stream[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
    const signal = init.signal as AbortSignal;
    signal.addEventListener('abort', () => { try { ctrl.error(new Error('aborted')); } catch { /* closed */ } });
    streams.push({ url, signal, push: (s) => ctrl.enqueue(enc.encode(s)), end: () => ctrl.close() });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  const dispatched: Array<{ jobId: string; req: TriggerRequest }> = [];
  const dispatcher = { dispatch: (jobId: string, req: TriggerRequest) => { dispatched.push({ jobId, req }); return { runId: 'r' }; } };
  const mgr = new RelayManager({
    dispatcher, fetch: fetchFn, random: () => 1,
    logger: createLogger({ verbose: false, component: 'test', sink: () => {} }),
    ...(opts.guardDrop ? { guard: () => false } : {}),
  });
  return { mgr, streams, dispatched };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0); };
const msg = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;

function job(id: string, relay: string | undefined, enabled = true): Job {
  return { id, enabled, schedule: { kind: 'webhook', ...(relay ? { relay } : {}) } } as unknown as Job;
}

describe('RelayManager', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('opens one connection for two jobs on the same URL and dispatches to both', async () => {
    const { mgr, streams, dispatched } = setup();
    mgr.subscribe('j1', A);
    mgr.subscribe('j2', A);
    await flush();
    expect(streams).toHaveLength(1);
    streams[0]!.push('event: ready\ndata: {}\n\n');
    streams[0]!.push(msg({ 'x-github-event': 'push', body: { a: 1 }, query: {} }));
    await flush();
    expect(dispatched.map((d) => d.jobId).sort()).toEqual(['j1', 'j2']);
    const req = dispatched[0]!.req;
    expect(req.kind).toBe('webhook');
    expect(req.env.CRONTICK_EVENT_SOURCE).toBe('relay');
    expect(req.env.CRONTICK_EVENT).toContain('"x-github-event":"push"');
    const st = mgr.status();
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ state: 'connected', eventCount: 1, jobIds: ['j1', 'j2'] });
    mgr.stop();
  });

  it('ignores ping/ready and drops bad JSON', async () => {
    const { mgr, streams, dispatched } = setup();
    mgr.subscribe('j1', A);
    await flush();
    streams[0]!.push('event: ping\ndata: {}\n\n');
    streams[0]!.push('data: not json\n\n');
    streams[0]!.push('data: [1]\n\n');
    await flush();
    expect(dispatched).toHaveLength(0);
    expect(mgr.status()[0]!.eventCount).toBe(0);
    mgr.stop();
  });

  it('refcounts: connection closes only when last job unsubscribes', async () => {
    const { mgr, streams } = setup();
    mgr.subscribe('j1', A);
    mgr.subscribe('j2', A);
    await flush();
    mgr.unsubscribe('j1');
    expect(streams[0]!.signal.aborted).toBe(false);
    mgr.unsubscribe('j2');
    expect(streams[0]!.signal.aborted).toBe(true);
    expect(mgr.status()).toEqual([]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(streams).toHaveLength(1);
  });

  it('sync: subscribes enabled webhook jobs, unsubscribes on disable/delete/relay change, idempotent', async () => {
    const { mgr, streams } = setup();
    mgr.sync([job('j1', A), job('j2', A), job('j3', undefined), job('j4', A, false)]);
    mgr.sync([job('j1', A), job('j2', A)]);
    await flush();
    expect(streams).toHaveLength(1);
    expect(mgr.status()[0]!.jobIds).toEqual(['j1', 'j2']);

    mgr.sync([job('j1', A, false), job('j2', A)]); // disable
    expect(mgr.status()[0]!.jobIds).toEqual(['j2']);
    mgr.sync([job('j1', A, false)]); // delete j2
    expect(mgr.status()).toEqual([]);

    mgr.sync([job('j1', A)]);
    await flush();
    mgr.sync([job('j1', B)]); // relay changed
    await flush();
    expect(streams).toHaveLength(3);
    expect(streams[1]!.signal.aborted).toBe(true);
    expect(mgr.status().map((s) => s.url)).toEqual([B]);
    mgr.stop();
  });

  it('non-webhook schedule kind is not subscribed', () => {
    const { mgr } = setup();
    mgr.sync([{ id: 'c', enabled: true, schedule: { kind: 'cron', expression: '* * * * *' } } as unknown as Job]);
    expect(mgr.status()).toEqual([]);
  });

  it('reconnects with exponential backoff capped at 60s', async () => {
    const { mgr, streams } = setup();
    mgr.subscribe('j1', A);
    await flush();
    streams[0]!.end();
    await flush();
    expect(mgr.status()[0]!.state).toBe('backoff');
    await vi.advanceTimersByTimeAsync(999);
    expect(streams).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(streams).toHaveLength(2); // 1s
    streams[1]!.end();
    await flush();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(streams).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(streams).toHaveLength(3); // 2s
    // grow until cap
    for (let i = 0; i < 10; i++) {
      streams[streams.length - 1]!.end();
      await flush();
      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
    }
    const n = streams.length;
    streams[n - 1]!.end();
    await flush();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(streams).toHaveLength(n);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(streams).toHaveLength(n + 1);
    mgr.stop();
  });

  it('resets backoff after 60s connected', async () => {
    const { mgr, streams } = setup();
    mgr.subscribe('j1', A);
    await flush();
    for (let i = 0; i < 3; i++) { // push attempt up
      streams[streams.length - 1]!.end();
      await flush();
      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
    }
    const last = streams[streams.length - 1]!;
    last.push(': hello\n\n'); // connected
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    last.push(': keepalive\n\n');
    await flush();
    last.end();
    await flush();
    const n = streams.length;
    await vi.advanceTimersByTimeAsync(1_000); // back to base delay
    await flush();
    expect(streams).toHaveLength(n + 1);
    mgr.stop();
  });

  it('idle watchdog aborts and reconnects after 90s without data', async () => {
    const { mgr, streams } = setup();
    mgr.subscribe('j1', A);
    await flush();
    streams[0]!.push(': hi\n\n');
    await flush();
    await vi.advanceTimersByTimeAsync(89_000);
    expect(streams[0]!.signal.aborted).toBe(false);
    streams[0]!.push(': ping\n\n'); // activity resets watchdog
    await flush();
    await vi.advanceTimersByTimeAsync(89_000);
    expect(streams[0]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(streams[0]!.signal.aborted).toBe(true);
    expect(mgr.status()[0]!.lastError).toMatch(/idle timeout/);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(streams).toHaveLength(2);
    mgr.stop();
  });

  it('processes nothing and reconnects nothing after stop()', async () => {
    const { mgr, streams, dispatched } = setup();
    mgr.subscribe('j1', A);
    await flush();
    mgr.stop();
    expect(streams[0]!.signal.aborted).toBe(true);
    try { streams[0]!.push(msg({ body: {} })); } catch { /* errored stream */ }
    await flush();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(dispatched).toHaveLength(0);
    expect(streams).toHaveLength(1);
    mgr.subscribe('j2', A);
    await flush();
    expect(streams).toHaveLength(1);
  });

  it('a job unsubscribed mid-event is not dispatched; guard seam can drop', async () => {
    const { mgr, streams, dispatched } = setup();
    mgr.subscribe('j1', A);
    mgr.subscribe('j2', A);
    await flush();
    mgr.unsubscribe('j2');
    streams[0]!.push(msg({ body: {} }));
    await flush();
    expect(dispatched.map((d) => d.jobId)).toEqual(['j1']);
    mgr.stop();

    const g = setup({ guardDrop: true });
    g.mgr.subscribe('j1', A);
    await flush();
    g.streams[0]!.push(msg({ body: {} }));
    await flush();
    expect(g.dispatched).toHaveLength(0);
    g.mgr.stop();
  });
});

describe('stale relay events vs real TriggerDispatcher', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('an edited or disabled job does not fire', async () => {
    let current: Job | undefined = job('j1', A);
    const runs: string[] = [];
    const store = {
      getJob: () => current,
      isJobBroken: () => false,
      insertRun: () => { runs.push('x'); return { id: 'run1' }; },
      setRunTrigger: () => {},
    };
    const runner = { run: () => Promise.resolve() };
    const dispatcher = new TriggerDispatcher({
      store: store as never, runner: runner as never, logger: createLogger({ verbose: false, component: 't', sink: () => {} }),
    });
    const streams: Array<{ push(s: string): void }> = [];
    const fetchFn = (async () => {
      let c!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start(ctrl) { c = ctrl; } });
      streams.push({ push: (x) => c.enqueue(enc.encode(x)) });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const mgr = new RelayManager({ dispatcher, fetch: fetchFn, logger: createLogger({ verbose: false, component: 't', sink: () => {} }) });
    mgr.subscribe('j1', A);
    await flush();
    streams[0]!.push(msg({ body: {} }));
    await flush();
    expect(runs).toHaveLength(1);

    current = job('j1', A, false); // disabled, manager not yet synced
    streams[0]!.push(msg({ body: {} }));
    await flush();
    expect(runs).toHaveLength(1);

    current = { ...job('j1', undefined), schedule: { kind: 'cron', cron: '* * * * *' } } as unknown as Job; // kind edited
    streams[0]!.push(msg({ body: {} }));
    await flush();
    expect(runs).toHaveLength(1);
    mgr.stop();
  });
});
