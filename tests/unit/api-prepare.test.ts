import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startApiHarness, type ApiHarness } from '../helpers/api-harness.js';
import { prepareCreate } from '../../src/job-prepare.js';

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

describe('daemon prepare mode + editor-meta', () => {
  let h: ApiHarness;
  let claudeDir: string;
  const prevClaude = process.env['CLAUDE_CONFIG_DIR'];
  beforeAll(async () => {
    claudeDir = tmp('ap-claude-');
    writeFileSync(join(claudeDir, '.claude.json'), `${JSON.stringify({ projects: {} })}\n`);
    process.env['CLAUDE_CONFIG_DIR'] = claudeDir;
    h = await startApiHarness('api-prepare');
  });
  afterAll(async () => {
    await h.close();
    if (prevClaude === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = prevClaude;
  });
  afterEach(() => {
    for (const d of dirs.splice(0).filter((x) => x !== claudeDir)) rmSync(d, { recursive: true, force: true });
    dirs.push(claudeDir);
  });

  const input = (cwd: string, extra: Record<string, unknown> = {}) => ({
    schedule: { kind: 'interval', everySec: 3600 },
    action: { kind: 'prompt', prompt: 'hi', cwd },
    ...extra,
  });

  it('editor-meta returns engines, defaults and alias pattern (not shadowed by /api/jobs/:id)', async () => {
    const r = await h.call('GET', '/api/jobs/editor-meta');
    expect(r.status).toBe(200);
    expect(r.data.engines).toEqual(expect.arrayContaining([{ name: 'claude', type: 'claude', supportsTrust: true }]));
    expect(r.data.defaultEngine).toBe('claude');
    expect(r.data.defaults.overlap).toBe('skip');
    expect(r.data.defaults.retry).toEqual({ max: 0, backoffSec: 30 });
    expect(r.data.aliasPattern).toBe('^[a-z0-9]+(?:-[a-z0-9]+)*$');
  });

  it('prepare create matches prepareCreate (defaults, autogen alias) and persists', async () => {
    const cwd = tmp('ap-proj-');
    const r = await h.call('POST', '/api/jobs?prepare=1&trustFolder=1', input(cwd));
    expect(r.status).toBe(201);
    const expected = prepareCreate(input(cwd) as never, { env: process.env, trustFolder: true });
    expect(r.data.alias).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect({ ...r.data, id: 'x', alias: 'x' }).toEqual({ ...expected, id: 'x', alias: 'x' });
    expect((await h.call('GET', `/api/jobs/${r.data.id}`)).status).toBe(200);
  });

  it('prepare create requires action.cwd and rejects nonexistent dirs', async () => {
    const noCwd = await h.call('POST', '/api/jobs?prepare=1', { schedule: { kind: 'interval', everySec: 60 }, action: { kind: 'prompt', prompt: 'hi' } });
    expect(noCwd.status).toBe(400);
    const bad = await h.call('POST', '/api/jobs?prepare=1', input('/definitely/not/here'));
    expect(bad.status).toBe(400);
    expect(bad.data.error.code).toBe('INVALID_CWD');
  });

  it('untrusted Claude dir -> TRUST_REQUIRED with folders; succeeds with trustFolder=1', async () => {
    const cwd = tmp('ap-untrusted-');
    const first = await h.call('POST', '/api/jobs?prepare=1', input(cwd, { alias: 'trust-me' }));
    expect(first.status).toBe(400);
    expect(first.data.error.code).toBe('TRUST_REQUIRED');
    expect(first.data.error.details.folders).toEqual([cwd]);
    expect(h.store.getJob('trust-me')).toBeUndefined();
    const second = await h.call('POST', '/api/jobs?prepare=1&trustFolder=1', input(cwd, { alias: 'trust-me' }));
    expect(second.status).toBe(201);
  });

  it('non-trust engines never return TRUST_REQUIRED', async () => {
    const cwd = tmp('ap-raw-');
    const r = await h.call('POST', '/api/jobs?prepare=1', input(cwd, { alias: 'raw-job', action: { kind: 'prompt', prompt: 'hi', cwd, engine: 'raw' } }));
    expect(r.data.error?.code).not.toBe('TRUST_REQUIRED');
  });

  it('prepare update merges field-wise, clears with null, and applies the cwd-session rule', async () => {
    const cwd = tmp('ap-upd-');
    const created = await h.call('POST', '/api/jobs?prepare=1&trustFolder=1', input(cwd, { alias: 'upd-job', description: 'old', action: { kind: 'prompt', prompt: 'hi', cwd, timeoutSec: 30, args: ['--x'] } }));
    expect(created.status).toBe(201);
    const r = await h.call('PUT', '/api/jobs/upd-job?prepare=1', { action: { kind: 'prompt', prompt: 'new' }, description: null });
    expect(r.status).toBe(200);
    expect(r.data.action.prompt).toBe('new');
    expect(r.data.action.cwd).toBe(cwd);
    expect(r.data.action.timeoutSec).toBe(30);
    expect(r.data.action.args).toEqual(['--x']);
    expect(r.data.description).toBeUndefined();
    const cleared = await h.call('PUT', '/api/jobs/upd-job?prepare=1', { action: { kind: 'prompt', timeoutSec: null } });
    expect(cleared.data.action.timeoutSec).toBeUndefined();

    h.store.upsertJob({ ...h.store.getJob('upd-job')!, action: { ...(h.store.getJob('upd-job')!.action as object), sessionId: 'abc' } as never });
    const other = tmp('ap-other-');
    const moved = await h.call('PUT', '/api/jobs/upd-job?prepare=1&trustFolder=1', { action: { kind: 'prompt', cwd: other } });
    expect(moved.status).toBe(400);
    expect(moved.data.error.code).toBe('CWD_CHANGE_BREAKS_SESSION');
  });

  it('prepare update requires trust only when the folder changed', async () => {
    const cwd = tmp('ap-t1-');
    await h.call('POST', '/api/jobs?prepare=1&trustFolder=1', input(cwd, { alias: 'trust-upd' }));
    const same = await h.call('PUT', '/api/jobs/trust-upd?prepare=1', { description: 'd' });
    expect(same.status).toBe(200);
    const moved = await h.call('PUT', '/api/jobs/trust-upd?prepare=1', { action: { kind: 'prompt', cwd: tmp('ap-t2-') } });
    expect(moved.data.error.code).toBe('TRUST_REQUIRED');
  });

  it('without prepare=1 the default routes are unchanged (no trust check, no cwd requirement)', async () => {
    const r = await h.call('POST', '/api/jobs', { schedule: { kind: 'interval', everySec: 60 }, action: { kind: 'prompt', prompt: 'hi', cwd: tmp('ap-plain-') } });
    expect(r.status).toBe(201);
  });
});
