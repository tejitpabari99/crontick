/** `GET /api/runs/:id/log/raw` (the per-job crontick log file) and `logFile` on `/api/runs/:id/output`. crontick stores no raw engine logs. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createApiServer } from '../../src/daemon/api.js';
import { Scheduler } from '../../src/daemon/scheduler.js';
import { startApiHarness, sampleJob, type ApiHarness } from '../helpers/api-harness.js';

let h: ApiHarness;
let jobId: string;
let runId: string;

beforeAll(async () => {
  h = await startApiHarness('api-raw-log');
  const created = await h.call('POST', '/api/jobs', sampleJob({ alias: 'raw-log-job' }));
  jobId = created.data.id as string;
  runId = h.store.insertRun(jobId).id;
  mkdirSync(join(h.dir, 'logs'), { recursive: true });
  writeFileSync(
    join(h.dir, 'logs', `${jobId}.log`),
    `2026-01-01T00:00:00.000Z [run ${runId}] run started\n2026-01-01T00:00:01.000Z [run ${runId}] boom token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD\n`,
  );
});
afterAll(async () => { await h.close(); });

async function raw(path: string): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetch(`${h.baseUrl}${path}`);
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe('GET /api/runs/:id/log/raw', () => {
  it('serves the job log file as inline plain text with nosniff, redacted', async () => {
    const r = await raw(`/api/runs/${runId}/log/raw`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(r.headers.get('content-disposition')).toBe(`inline; filename="${runId}.log"`);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.text).toContain('run started');
    expect(r.text).toContain('boom');
    expect(r.text).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('returns 404 for unknown and malformed ids (no path is built from the URL)', async () => {
    expect((await raw('/api/runs/does-not-exist/log/raw')).status).toBe(404);
    expect((await raw('/api/runs/..%2Fx/log/raw')).status).toBe(404);
    expect((await raw('/api/runs/%2e%2e%2f%2e%2e%2fetc%2fpasswd/log/raw')).status).toBe(404);
  });

  it('returns 403 for a non-loopback remote address', async () => {
    const server = createApiServer({ store: h.store, scheduler: new Scheduler(), runner: {} as never, startedAt: new Date(), port: 0, reload: async () => {} });
    const res = { statusCode: 0, headers: {} as Record<string, unknown>, body: '', writeHead(code: number, headers: Record<string, unknown>) { this.statusCode = code; this.headers = headers; }, end(chunk?: string) { this.body = chunk ?? ''; } };
    server.emit('request', { socket: { remoteAddress: '10.1.2.3' }, url: `/api/runs/${runId}/log/raw`, method: 'GET', headers: {} }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('run started');
  });
});

describe('GET /api/runs/:id/output logFile', () => {
  it('returns the per-job log file path', async () => {
    const out = await h.call('GET', `/api/runs/${runId}/output`);
    expect(out.status).toBe(200);
    expect(out.data.logFile).toBe(resolve(join(h.dir, 'logs', `${jobId}.log`)));
  });
});

describe('removed raw-log endpoints', () => {
  it('no longer exposes stored engine logs or a log stream', async () => {
    expect((await raw(`/api/runs/${runId}/logs`)).status).toBe(404);
    expect((await raw(`/api/runs/${runId}/logs/stream`)).status).toBe(404);
  });
});
