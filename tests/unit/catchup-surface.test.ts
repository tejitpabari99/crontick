/* eslint-disable @typescript-eslint/no-explicit-any -- loose casts for fake-daemon bodies */
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '../../src/client.js';
import { buildJobFromCreateOptions, buildJobPatchFromUpdateOptions, JobPatchInputSchema } from '../../src/job-input.js';
import { prepareCreate, prepareUpdate } from '../../src/job-prepare.js';
import { SURFACE_CAPABILITIES } from '../../src/surface.js';
import { writeTestConfig } from '../helpers/test-home.js';

const closers: Array<() => Promise<void>> = [];
const homes: string[] = [];
const CLI = resolve('dist/cli/index.js');
function cli(args: string[], home: string) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', env: { ...process.env, CRONTICK_HOME: home, CRONTICK_VERBOSE: '' }, timeout: 30_000 });
}
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const h of homes.splice(0)) { cli(['daemon', 'stop'], h); rmSync(h, { recursive: true, force: true }); }
});

async function fakeDaemon(existing: any): Promise<{ url: string; requests: Array<{ method: string; url: string; body: any }> }> {
  const requests: Array<{ method: string; url: string; body: any }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      const send = (s: number, b: unknown) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.url === '/health') return send(200, { ok: true, product: 'crontick', pid: 1, port: (server.address() as { port: number }).port });
      if (req.method === 'POST' && req.url === '/api/jobs') return send(201, body);
      if (req.method === 'GET' && req.url?.startsWith('/api/jobs/')) return send(200, existing);
      if (req.method === 'PUT') return send(200, body);
      send(404, { error: { code: 'NOT_FOUND', message: 'x' } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise<void>((r) => { server.close(() => r()); }));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
}

const base = { prompt: 'p', cwd: '/tmp' };
const existing = {
  id: '11111111-1111-4111-8111-111111111111', alias: 'j', enabled: true, catchUp: true,
  schedule: { kind: 'interval', everySec: 60 }, overlap: 'skip', retry: { max: 0, backoffSec: 30 },
  action: { kind: 'prompt', prompt: 'x', args: [], reuseSession: false, engine: 'raw', cwd: '/tmp' },
};

describe('catchUp option building', () => {
  it('create carries catchUp; omitted -> false', () => {
    expect(buildJobFromCreateOptions({ ...base, every: 60, catchUp: true }, { cwd: '/tmp' }).catchUp).toBe(true);
    expect(buildJobFromCreateOptions({ ...base, every: 60 }, { cwd: '/tmp' }).catchUp).toBe(false);
  });
  it('create rejects catchUp on non-time kinds with VALIDATION_ERROR', () => {
    const up = '11111111-1111-4111-8111-111111111111';
    expect(() => buildJobFromCreateOptions({ ...base, after: up, catchUp: true }, { cwd: '/tmp' })).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => prepareCreate({ schedule: { kind: 'webhook' }, catchUp: true, action: { kind: 'prompt', prompt: 'x', cwd: '/tmp' } } as any, { cwd: '/tmp' }))
      .toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
  it('patch includes catchUp only when specified (true and false)', () => {
    expect(buildJobPatchFromUpdateOptions({ catchUp: true })).toEqual({ catchUp: true });
    expect(buildJobPatchFromUpdateOptions({ catchUp: false })).toEqual({ catchUp: false });
    expect(buildJobPatchFromUpdateOptions({ desc: 'd' })).not.toHaveProperty('catchUp');
  });
  it('JobPatchInputSchema accepts catchUp', () => {
    expect(JobPatchInputSchema.safeParse({ catchUp: false }).success).toBe(true);
  });
  it('prepareUpdate: omitted leaves unchanged; set changes; true on webhook rejected', () => {
    expect(prepareUpdate(existing as any, { description: 'd' }, { cwd: '/tmp' }).catchUp).toBe(true);
    expect(prepareUpdate(existing as any, { catchUp: false }, { cwd: '/tmp' }).catchUp).toBe(false);
    expect(() => prepareUpdate(existing as any, { schedule: { kind: 'webhook' } as any }, { cwd: '/tmp' })).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});

describe('catchUp client + surface', () => {
  it('createJob POSTs catchUp; updateJob PUTs it and omits it when unset', async () => {
    const d = await fakeDaemon(existing);
    const client = createClient({ daemonUrl: d.url });
    await client.createJob({ alias: 'a', schedule: { kind: 'interval', everySec: 60 }, catchUp: true, action: { kind: 'prompt', prompt: 'x', cwd: '/tmp' } });
    expect(d.requests.find((r) => r.method === 'POST')!.body.catchUp).toBe(true);
    await client.updateJob('j', { catchUp: false });
    await client.updateJob('j', { description: 'd' });
    const puts = d.requests.filter((r) => r.method === 'PUT');
    expect(puts[0]!.body.catchUp).toBe(false);
    expect(puts[1]!.body.catchUp).toBe(true); // existing value carried by the merged body, not reset
  });
  it('SURFACE_CAPABILITIES lists catchUp on create and update', () => {
    for (const name of ['create-job', 'update-job']) {
      expect((SURFACE_CAPABILITIES.find((c) => c.capability === name) as { optionNames?: readonly string[] } | undefined)?.optionNames).toContain('catchUp');
    }
  });
});

describe('catchUp CLI', () => {
  it('--catch-up / --no-catch-up round-trip; update without flag leaves it unchanged; non-time kind rejected', () => {
    const home = mkdtempSync(join(tmpdir(), 'crontick-catchup-'));
    homes.push(home);
    writeTestConfig(home);
    const made = cli(['jobs', 'new', '-a', 'cu', '-p', 'x', '--every', '1h', '--catch-up'], home);
    expect(made.status, made.stderr).toBe(0);
    expect(cli(['jobs', 'get', 'cu'], home).stdout).toContain('catchUp: true');
    const desc = cli(['jobs', 'update', 'cu', '--desc', 'hello'], home);
    expect(desc.status, desc.stderr).toBe(0);
    expect(cli(['jobs', 'get', 'cu'], home).stdout).toContain('catchUp: true');
    expect(cli(['jobs', 'update', 'cu', '--no-catch-up'], home).status).toBe(0);
    expect(cli(['jobs', 'get', 'cu'], home).stdout).toContain('catchUp: false');
    const bad = cli(['jobs', 'new', '-a', 'cw', '-p', 'x', '--webhook', '--catch-up'], home);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('VALIDATION_ERROR');
  }, 90_000);
});
