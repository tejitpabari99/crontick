/* eslint-disable @typescript-eslint/no-explicit-any -- loose casts for fake-daemon bodies */
import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '../../src/client.js';
import { resolvePayloadArg } from '../../src/cli/payload-source.js';
import { parseTriggerPayload } from '../../src/utils/trigger-payload.js';
import { SURFACE_CAPABILITIES } from '../../src/surface.js';
import { startApiHarness, sampleJob, type ApiHarness } from '../helpers/api-harness.js';

describe('parseTriggerPayload', () => {
  it('parses any JSON value', () => {
    expect(parseTriggerPayload('{"a":1}')).toEqual({ a: 1 });
    expect(parseTriggerPayload('[1,2]')).toEqual([1, 2]);
    expect(parseTriggerPayload('"hi"')).toBe('hi');
    expect(parseTriggerPayload('null')).toBeNull();
    expect(parseTriggerPayload('0')).toBe(0);
  });
  it('throws INVALID_PAYLOAD for non-JSON', () => {
    expect(() => parseTriggerPayload('not json')).toThrow(expect.objectContaining({ code: 'INVALID_PAYLOAD' }));
    expect(() => parseTriggerPayload('')).toThrow(expect.objectContaining({ code: 'INVALID_PAYLOAD' }));
  });
});

describe('resolvePayloadArg', () => {
  const io = { readFile: (p: string) => `{"file":"${p}"}`, readStdin: () => '{"stdin":true}' };
  it('undefined stays undefined', () => { expect(resolvePayloadArg(undefined, io)).toBeUndefined(); });
  it('inline JSON', () => { expect(resolvePayloadArg('{"x":2}', io)).toEqual({ x: 2 }); });
  it('@file reads the file', () => { expect(resolvePayloadArg('@/tmp/p.json', io)).toEqual({ file: '/tmp/p.json' }); });
  it('- reads stdin', () => { expect(resolvePayloadArg('-', io)).toEqual({ stdin: true }); });
  it('invalid inline JSON -> INVALID_PAYLOAD', () => {
    expect(() => resolvePayloadArg('{oops', io)).toThrow(expect.objectContaining({ code: 'INVALID_PAYLOAD' }));
  });
  it('unreadable file -> INVALID_PAYLOAD', () => {
    const bad = { ...io, readFile: () => { throw new Error('ENOENT'); } };
    expect(() => resolvePayloadArg('@nope', bad)).toThrow(expect.objectContaining({ code: 'INVALID_PAYLOAD' }));
  });
});

describe('surface capabilities', () => {
  it('registers trigger-job on client, CLI, MCP', () => {
    expect(SURFACE_CAPABILITIES.find((c) => c.capability === 'trigger-job')).toMatchObject({
      clientMethod: 'triggerJob', cliCommand: ['jobs', 'trigger'], mcpTool: 'crontick_job_trigger',
    });
  });
  it('create/update-job list the webhook schedule options', () => {
    for (const name of ['create-job', 'update-job']) {
      const cap = SURFACE_CAPABILITIES.find((c) => c.capability === name) as { optionNames?: readonly string[] };
      expect(cap.optionNames).toEqual(expect.arrayContaining(['webhook', 'relay', 'webhookSecret']));
    }
  });
});

describe('client.triggerJob', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });
  async function fake(): Promise<{ url: string; requests: Array<{ method: string; url: string; body: any }> }> {
    const requests: Array<{ method: string; url: string; body: any }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        requests.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : undefined });
        const send = (s: number, b: unknown): void => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
        if (req.url === '/health') return send(200, { ok: true, product: 'crontick', pid: 1, port: (server.address() as { port: number }).port });
        if (req.url === '/api/jobs/hook/trigger') return send(202, { runId: 'r1' });
        send(404, { error: { code: 'JOB_NOT_FOUND', message: 'nope' } });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise<void>((r) => { server.close(() => r()); }));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
  }

  it('POSTs /api/jobs/:id/trigger with {payload} and returns {runId}', async () => {
    const d = await fake();
    const client = createClient({ daemonUrl: d.url });
    await expect(client.triggerJob('hook', { payload: { a: 1 } })).resolves.toEqual({ runId: 'r1' });
    const req = d.requests.find((r) => r.url === '/api/jobs/hook/trigger')!;
    expect(req.method).toBe('POST');
    expect(req.body).toEqual({ payload: { a: 1 } });
  });
  it('omits payload when not given', async () => {
    const d = await fake();
    const client = createClient({ daemonUrl: d.url });
    await client.triggerJob('hook');
    expect(d.requests.find((r) => r.url === '/api/jobs/hook/trigger')!.body ?? {}).toEqual({});
  });
  it('rejects a non-serializable payload with INVALID_PAYLOAD', async () => {
    const d = await fake();
    const client = createClient({ daemonUrl: d.url });
    await expect(client.triggerJob('hook', { payload: 1n })).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    await expect(client.triggerJob('hook', { payload: () => 1 })).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
  });
});

describe('POST /api/jobs/:id/trigger', () => {
  let h: ApiHarness;
  const runs: Array<{ jobId: string; runId: string; opts: any }> = [];
  let hookId: string;
  beforeAll(async () => {
    h = await startApiHarness('webhook-trigger', {
      run: (async (job: any, runId: string, _store: unknown, opts: any) => { runs.push({ jobId: job.id, runId, opts }); }) as any,
    });
    hookId = (await h.call('POST', '/api/jobs', sampleJob({ alias: 'hook', schedule: { kind: 'webhook' } }))).data.id as string;
  });
  afterAll(async () => { await h.close(); });

  it('fires a webhook job via alias with payload, env and trigger_json (local source)', async () => {
    const res = await h.call('POST', '/api/jobs/hook/trigger', { payload: { ref: 'main' } });
    expect(res.status).toBe(202);
    expect(typeof res.data.runId).toBe('string');
    await new Promise((r) => setTimeout(r, 20));
    const run = runs.find((r) => r.runId === res.data.runId)!;
    expect(run.jobId).toBe(hookId);
    expect(run.opts.env.CRONTICK_TRIGGER).toBe('webhook');
    expect(run.opts.env.CRONTICK_EVENT_SOURCE).toBe('local');
    expect(JSON.parse(run.opts.env.CRONTICK_EVENT).body).toEqual({ ref: 'main' });
    expect(run.opts.promptSuffix).toContain('untrusted');
    expect(h.store.getRunTrigger(res.data.runId)).toMatchObject({ source: 'local' });
  });
  it('works without a payload', async () => {
    const res = await h.call('POST', `/api/jobs/${hookId}/trigger`);
    expect(res.status).toBe(202);
    expect(res.data.runId).toBeTruthy();
  });
  it('non-webhook job -> NOT_WEBHOOK_JOB mentioning run-now', async () => {
    await h.call('POST', '/api/jobs', sampleJob({ alias: 'plain' }));
    const res = await h.call('POST', '/api/jobs/plain/trigger', {});
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe('NOT_WEBHOOK_JOB');
    expect(res.data.error.message).toContain('run-now');
  });
  it('disabled webhook job -> JOB_DISABLED', async () => {
    await h.call('POST', '/api/jobs', sampleJob({ alias: 'off', enabled: false, schedule: { kind: 'webhook' } }));
    const res = await h.call('POST', '/api/jobs/off/trigger', {});
    expect(res.status).toBe(409);
    expect(res.data.error.code).toBe('JOB_DISABLED');
  });
  it('unknown job -> JOB_NOT_FOUND', async () => {
    const res = await h.call('POST', '/api/jobs/ghost/trigger', {});
    expect(res.status).toBe(404);
    expect(res.data.error.code).toBe('JOB_NOT_FOUND');
  });
  it('malformed JSON body -> INVALID_PAYLOAD', async () => {
    const res = await fetch(`${h.baseUrl}/api/jobs/hook/trigger`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('INVALID_PAYLOAD');
  });
  it('cross-origin POST is rejected by the request guard', async () => {
    const res = await fetch(`${h.baseUrl}/api/jobs/hook/trigger`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe('REQUEST_REJECTED');
  });
  it('text/plain POST is rejected by the guard', async () => {
    const res = await fetch(`${h.baseUrl}/api/jobs/hook/trigger`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    expect(res.status).toBe(415);
  });
});
