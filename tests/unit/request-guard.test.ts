import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { startApiHarness, sampleJob, type ApiHarness } from '../helpers/api-harness.js';

interface Res { status: number; data: { error?: { code?: string } } }

function raw(port: number, method: string, path: string, headers: Record<string, string | undefined>): Promise<Res> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h, agent: false }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => (text += c.toString()));
      res.on('end', () => {
        let data: Res['data'] = {};
        try { data = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Every mutating route in src/daemon/api.ts. Adding a mutating route without
// listing it here fails the source-count test below; listing it checks the guard.
const MUTATING_ROUTES: Array<[string, string]> = [
  ['POST', '/api/jobs'],
  ['DELETE', '/api/jobs'],
  ['PUT', '/api/jobs/x'],
  ['POST', '/api/jobs?prepare=1&trustFolder=1'], // prepare variant: same source condition as POST /api/jobs
  ['PUT', '/api/jobs/x?prepare=1&trustFolder=1'], // prepare variant: same source condition as PUT /api/jobs/:id
  ['DELETE', '/api/jobs/x'],
  ['POST', '/api/jobs/x/enable'],
  ['POST', '/api/jobs/x/disable'],
  ['POST', '/api/jobs/x/run'],
  ['POST', '/api/jobs/x/run-now'], // alias of /run: same source condition
  ['POST', '/api/jobs/x/trigger'],
  ['DELETE', '/api/runs'],
  ['POST', '/api/runs/x/cancel'],
  ['POST', '/api/schedules/validate'],
  ['POST', '/api/schedules/validate?jobId=x'], // after-cycle variant: same source condition
  ['POST', '/api/schedules/preview'],
  ['POST', '/api/relay/new'],
  ['POST', '/api/daemon/reload'],
  ['POST', '/api/daemon/stop'],
  ['POST', '/api/daemon/pause'],
  ['POST', '/api/daemon/resume'],
  ['POST', '/api/import'],
  ['PATCH', '/api/config'],
];

describe('API request guard', () => {
  let h: ApiHarness;
  beforeAll(async () => { h = await startApiHarness('request-guard'); });
  afterAll(async () => { await h.close(); });

  const good = (extra: Record<string, string | undefined> = {}) => ({
    Host: `127.0.0.1:${h.port}`,
    'Content-Type': 'application/json',
    ...extra,
  });

  it('route list covers every mutating route in api.ts source', () => {
    const src = readFileSync('src/daemon/api.ts', 'utf8');
    const count = (src.match(/method === '(POST|PUT|PATCH|DELETE)'/g) ?? []).length;
    const aliases = MUTATING_ROUTES.filter(([, p]) => p.endsWith('/run-now') || p.includes('?prepare=1') || p.includes('?jobId=')).length;
    expect(count).toBe(MUTATING_ROUTES.length - aliases);
  });

  it.each(MUTATING_ROUTES)('%s %s rejects bad Host, non-JSON type, bad Origin', async (method, path) => {
    for (const headers of [
      good({ Host: 'evil.com' }),
      good({ Host: `127.0.0.1:${h.port + 1}` }),
      good({ 'Content-Type': 'text/plain' }),
      good({ 'Content-Type': undefined }),
      good({ Origin: 'http://evil.com' }),
      good({ Origin: 'null' }),
    ]) {
      const r = await raw(h.port, method, path, headers);
      expect([403, 415]).toContain(r.status);
      expect(r.data.error?.code).toBe('REQUEST_REJECTED');
    }
  });

  it('unknown mutating /api paths are also guarded', async () => {
    const r = await raw(h.port, 'PATCH', '/api/anything', good({ Host: 'evil.com' }));
    expect(r.data.error?.code).toBe('REQUEST_REJECTED');
  });

  it('rejected request executes nothing', async () => {
    const created = await h.call('POST', '/api/jobs', sampleJob());
    const id = (created.data as { id: string }).id;
    const r = await raw(h.port, 'DELETE', `/api/jobs/${id}`, good({ Host: 'evil.com' }));
    expect(r.status).toBe(403);
    expect((await h.call('GET', `/api/jobs/${id}`)).status).toBe(200);
  });

  it('accepts loopback hosts, JSON (with charset), absent/matching Origin', async () => {
    for (const headers of [
      good(),
      good({ Host: `localhost:${h.port}` }),
      good({ Host: `[::1]:${h.port}` }),
      good({ 'Content-Type': 'application/json; charset=utf-8' }),
      good({ Origin: `http://127.0.0.1:${h.port}` }),
      good({ Origin: `http://localhost:${h.port}` }),
    ]) {
      const r = await raw(h.port, 'POST', '/api/schedules/validate', headers);
      expect(r.data.error?.code).not.toBe('REQUEST_REJECTED');
    }
  });

  it('GET routes are not subject to the guard', async () => {
    const r = await raw(h.port, 'GET', '/api/jobs', { Host: `127.0.0.1:${h.port}` });
    expect(r.status).toBe(200);
  });
});
