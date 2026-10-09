/* eslint-disable @typescript-eslint/no-explicit-any -- loose casts for fake-daemon bodies and schedule unions */
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '../../src/client.js';
import { SCHEDULE_FLAGS, scheduleFooter } from '../../src/constants/cli-schedule.js';
import { buildJobFromCreateOptions, buildJobPatchFromUpdateOptions, JobCreateInputSchema, JobPatchInputSchema } from '../../src/job-input.js';
import { SURFACE_CAPABILITIES } from '../../src/surface.js';

const UP_ID = '11111111-1111-4111-8111-111111111111';
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

async function fakeDaemon(): Promise<{ url: string; requests: Array<{ method: string; url: string; body: any }> }> {
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
      if (req.url === '/api/jobs/etl') return send(200, { id: UP_ID, alias: 'etl' });
      if (req.url?.startsWith('/api/jobs/ghost')) return send(404, { error: { code: 'JOB_NOT_FOUND', message: 'nope' } });
      if (req.method === 'POST' && req.url === '/api/jobs') return send(201, body);
      if (req.method === 'DELETE') return send(200, { ok: true });
      if (req.method === 'GET' && req.url === `/api/jobs/${UP_ID}`) return send(200, { id: UP_ID, alias: 'etl' });
      send(404, { error: { code: 'NOT_FOUND', message: 'x' } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise<void>((r) => { server.close(() => r()); }));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests };
}

const base = { prompt: 'p', cwd: '/tmp' };

describe('--after CLI option building', () => {
  it('builds an after schedule with default and explicit status', () => {
    expect((buildJobFromCreateOptions({ ...base, after: UP_ID }, { cwd: '/tmp' }) as any).schedule).toEqual({ kind: 'after', jobId: UP_ID, status: 'success' });
    expect((buildJobFromCreateOptions({ ...base, after: UP_ID, afterStatus: 'any' }, { cwd: '/tmp' }) as any).schedule).toEqual({ kind: 'after', jobId: UP_ID, status: 'any' });
  });
  it('rejects --after with another schedule, bad status, and --after-status alone', () => {
    expect(() => buildJobFromCreateOptions({ ...base, after: UP_ID, cron: '* * * * *' }, { cwd: '/tmp' })).toThrow(/only one schedule/);
    expect(() => buildJobFromCreateOptions({ ...base, after: UP_ID, afterStatus: 'bogus' }, { cwd: '/tmp' })).toThrow(/success, failure, or any/);
    expect(() => buildJobFromCreateOptions({ ...base, cron: '* * * * *', afterStatus: 'any' }, { cwd: '/tmp' })).toThrow(/--after-status requires --after/);
    expect(() => buildJobPatchFromUpdateOptions({ afterStatus: 'any' }, { cwd: '/tmp' })).toThrow(/--after-status requires --after/);
  });
  it('update builds an after patch', () => {
    expect(buildJobPatchFromUpdateOptions({ after: UP_ID }, { cwd: '/tmp' }).schedule).toEqual({ kind: 'after', jobId: UP_ID, status: 'success' });
  });
  it('--after is in SCHEDULE_FLAGS and the footer', () => {
    expect(SCHEDULE_FLAGS.map((f) => f.flag)).toContain('--after');
    expect(scheduleFooter()).toContain('--after');
  });
  it('input schemas accept an alias as jobId', () => {
    const schedule = { kind: 'after', jobId: 'etl', status: 'success' };
    expect(JobPatchInputSchema.safeParse({ schedule }).success).toBe(true);
    expect(JobCreateInputSchema.safeParse({ schedule, action: { kind: 'prompt', prompt: 'x' } }).success).toBe(true);
  });
});

describe('client after resolution and delete force', () => {
  it('createJob resolves the upstream alias to its GUID before POST', async () => {
    const d = await fakeDaemon();
    const client = createClient({ daemonUrl: d.url });
    const job = await client.createJob({ alias: 'down', schedule: { kind: 'after', jobId: 'etl', status: 'success' } as any, action: { kind: 'prompt', prompt: 'x', cwd: '/tmp' } });
    expect((job.schedule as any).jobId).toBe(UP_ID);
    expect(d.requests.find((r) => r.method === 'POST')!.body.schedule.jobId).toBe(UP_ID);
  });
  it('createJob with an unknown upstream throws AFTER_UPSTREAM_NOT_FOUND', async () => {
    const d = await fakeDaemon();
    const client = createClient({ daemonUrl: d.url });
    await expect(client.createJob({ alias: 'down', schedule: { kind: 'after', jobId: 'ghost', status: 'success' } as any, action: { kind: 'prompt', prompt: 'x', cwd: '/tmp' } }))
      .rejects.toMatchObject({ code: 'AFTER_UPSTREAM_NOT_FOUND' });
    expect(d.requests.some((r) => r.method === 'POST')).toBe(false);
  });
  it('createJobFromCliOptions resolves --after alias to GUID; unknown alias errors', async () => {
    const d = await fakeDaemon();
    const client = createClient({ daemonUrl: d.url });
    const job = await client.createJobFromCliOptions({ prompt: 'p', cwd: '/tmp', after: 'etl', afterStatus: 'failure' });
    expect(job.schedule).toEqual({ kind: 'after', jobId: UP_ID, status: 'failure' });
    await expect(client.createJobFromCliOptions({ prompt: 'p', cwd: '/tmp', after: 'ghost' })).rejects.toMatchObject({ code: 'AFTER_UPSTREAM_NOT_FOUND' });
  });
  it('deleteJob forwards force as ?force=1', async () => {
    const d = await fakeDaemon();
    const client = createClient({ daemonUrl: d.url });
    await client.deleteJob('etl', { force: true });
    await client.deleteJob('etl');
    const dels = d.requests.filter((r) => r.method === 'DELETE').map((r) => r.url);
    expect(dels).toEqual(['/api/jobs/etl?force=1', '/api/jobs/etl']);
  });
  it('delete-job surface capability lists force', () => {
    expect(SURFACE_CAPABILITIES.find((c) => c.capability === 'delete-job')?.optionNames).toContain('force');
  });
});
