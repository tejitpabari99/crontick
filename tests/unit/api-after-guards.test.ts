import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startApiHarness, sampleJob, type ApiHarness } from '../helpers/api-harness.js';

describe('API after-trigger guards', () => {
  let h: ApiHarness;
  beforeAll(async () => { h = await startApiHarness('api-after-guards'); });
  afterAll(async () => { await h.close(); });

  const after = (jobId: string, extra: Record<string, unknown> = {}) =>
    sampleJob({ schedule: { kind: 'after', jobId, status: 'success' }, ...extra });
  const mk = async (extra: Record<string, unknown> = {}) => {
    const r = await h.call('POST', '/api/jobs', sampleJob({ alias: `up-${randomUUID().slice(0, 8)}`, ...extra }));
    expect(r.status).toBe(201);
    return r.data;
  };

  it('create rejects dangling upstream with AFTER_UPSTREAM_NOT_FOUND', async () => {
    const r = await h.call('POST', '/api/jobs', after(randomUUID()));
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('AFTER_UPSTREAM_NOT_FOUND');
  });

  it('create accepts existing upstream', async () => {
    const up = await mk();
    const r = await h.call('POST', '/api/jobs', after(up.id));
    expect(r.status).toBe(201);
  });

  it('update rejects self-cycle and 2-node cycle with AFTER_CYCLE', async () => {
    const a = await mk();
    const b = (await h.call('POST', '/api/jobs', after(a.id))).data;
    const self = await h.call('PUT', `/api/jobs/${b.id}`, { schedule: { kind: 'after', jobId: b.id, status: 'any' } });
    expect(self.status).toBe(400);
    expect(self.data.error.code).toBe('AFTER_CYCLE');
    const cyc = await h.call('PUT', `/api/jobs/${a.id}`, { schedule: { kind: 'after', jobId: b.id, status: 'any' } });
    expect(cyc.status).toBe(400);
    expect(cyc.data.error.code).toBe('AFTER_CYCLE');
    expect(h.store.getJob(a.id)?.schedule.kind).toBe('interval');
  });

  it('prepare mode resolves an upstream alias to the GUID; unknown alias is AFTER_UPSTREAM_NOT_FOUND', async () => {
    const up = await mk();
    const ok = await h.call('POST', '/api/jobs?prepare=1&trustFolder=1', {
      schedule: { kind: 'after', jobId: up.alias, status: 'failure' },
      action: { kind: 'prompt', prompt: 'hi', cwd: process.cwd(), engine: 'raw' },
    });
    expect(ok.status).toBe(201);
    expect(ok.data.schedule.jobId).toBe(up.id);
    const bad = await h.call('POST', '/api/jobs?prepare=1&trustFolder=1', {
      schedule: { kind: 'after', jobId: 'no-such-alias', status: 'any' },
      action: { kind: 'prompt', prompt: 'hi', cwd: process.cwd(), engine: 'raw' },
    });
    expect(bad.status).toBe(400);
    expect(bad.data.error.code).toBe('AFTER_UPSTREAM_NOT_FOUND');
  });

  it('enable rejects a job whose upstream was force-deleted', async () => {
    const up = await mk();
    const dep = (await h.call('POST', '/api/jobs', after(up.id))).data;
    const del = await h.call('DELETE', `/api/jobs/${up.id}?force=1`);
    expect(del.status).toBe(200);
    expect(h.store.getJob(dep.id)?.enabled).toBe(false);
    const en = await h.call('POST', `/api/jobs/${dep.id}/enable`);
    expect(en.status).toBe(400);
    expect(en.data.error.code).toBe('AFTER_UPSTREAM_NOT_FOUND');
    expect(h.store.getJob(dep.id)?.enabled).toBe(false);
  });

  it('delete with dependents refuses JOB_HAS_DEPENDENTS listing aliases and --force; force disables them', async () => {
    const up = await mk();
    const d1 = (await h.call('POST', '/api/jobs', after(up.id, { alias: 'dep-one' }))).data;
    await h.call('POST', '/api/jobs', after(up.id, { alias: 'dep-two' }));
    const r = await h.call('DELETE', `/api/jobs/${up.id}`);
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('JOB_HAS_DEPENDENTS');
    expect(r.data.error.message).toMatch(/dep-one/);
    expect(r.data.error.message).toMatch(/dep-two/);
    expect(r.data.error.message).toMatch(/--force/);
    expect(h.store.getJob(up.id)).toBeDefined();
    const f = await h.call('DELETE', `/api/jobs/${up.id}?force=1`);
    expect(f.status).toBe(200);
    expect(h.store.getJob(d1.id)?.enabled).toBe(false);
    expect(h.store.getJob(d1.id)?.schedule).toMatchObject({ kind: 'after', jobId: up.id });
  });

  it('import: dangling upstream imports disabled with error, cycles rejected, rest proceeds', async () => {
    const A = randomUUID(), B = randomUUID(), C = randomUUID(), D = randomUUID(), E = randomUUID();
    const jobs = [
      sampleJob({ id: A, alias: 'imp-a' }),
      sampleJob({ id: B, alias: 'imp-b', ...after(A) }),
      sampleJob({ id: C, alias: 'imp-c', ...after(randomUUID()) }),
      sampleJob({ id: D, alias: 'imp-d', ...after(E) }),
      sampleJob({ id: E, alias: 'imp-e', ...after(D) }),
    ];
    const r = await h.call('POST', '/api/import', { jobs });
    expect(r.status).toBe(200);
    const by = (alias: string) => r.data.results.find((x: { alias?: string }) => x.alias === alias);
    expect(by('imp-a').ok).toBe(true);
    expect(by('imp-b').ok).toBe(true);
    expect(by('imp-c').ok).toBe(true);
    expect(by('imp-c').error).toMatch(/AFTER_UPSTREAM_NOT_FOUND/);
    expect(h.store.getJob(C)?.enabled).toBe(false);
    expect(by('imp-d').ok).toBe(false);
    expect(by('imp-d').error).toMatch(/AFTER_CYCLE/);
    expect(by('imp-e').ok).toBe(false);
    expect(h.store.getJob(D)).toBeUndefined();
    expect(h.store.getJob(B)?.enabled).toBe(true);
  });

  it('validate: after checks upstream exists and optional ?jobId= cycle check', async () => {
    const a = await mk();
    const b = (await h.call('POST', '/api/jobs', after(a.id))).data;
    const ok = await h.call('POST', '/api/schedules/validate', { kind: 'after', jobId: a.id, status: 'success' });
    expect(ok.data.ok).toBe(true);
    const missing = await h.call('POST', '/api/schedules/validate', { kind: 'after', jobId: randomUUID(), status: 'success' });
    expect(missing.data.ok).toBe(false);
    expect(missing.data.error).toMatch(/AFTER_UPSTREAM_NOT_FOUND/);
    const cyc = await h.call('POST', `/api/schedules/validate?jobId=${a.id}`, { kind: 'after', jobId: b.id, status: 'success' });
    expect(cyc.data.ok).toBe(false);
    expect(cyc.data.error).toMatch(/AFTER_CYCLE/);
  });

  it('preview: after returns empty fires and the trigger', async () => {
    const a = await mk();
    const sched = { kind: 'after', jobId: a.id, status: 'any' };
    const r = await h.call('POST', '/api/schedules/preview', { schedule: sched });
    expect(r.status).toBe(200);
    expect(r.data.fires).toEqual([]);
    expect(r.data.trigger).toMatchObject(sched);
  });

  it('renaming an upstream alias leaves the dependent reference intact', async () => {
    const up = await mk();
    const dep = (await h.call('POST', '/api/jobs', after(up.id))).data;
    const r = await h.call('PUT', `/api/jobs/${up.id}`, { alias: 'renamed-upstream' });
    expect(r.status).toBe(200);
    expect(h.store.getJob(dep.id)?.schedule).toMatchObject({ jobId: up.id });
    expect(h.store.listDependents(up.id).map((j) => j.id)).toContain(dep.id);
  });

  it('regression: import does not treat a batch job that failed to import as an available upstream', async () => {
    const badUp = { ...sampleJob({ alias: `bad-${randomUUID().slice(0, 8)}`, schedule: { kind: 'once', runAt: '2000-01-01T00:00:00Z' } }), id: randomUUID() };
    const dep = { ...after(badUp.id), id: randomUUID() };
    const r = await h.call('POST', '/api/import', { jobs: [badUp, dep] });
    expect(r.status).toBe(200);
    const depRow = r.data.results.find((x: { id: string }) => x.id === dep.id);
    expect(r.data.results.find((x: { id: string }) => x.id === badUp.id)?.ok).toBe(false);
    expect(depRow.ok).toBe(true);
    expect(depRow.disabled).toBe(true);
    expect(depRow.error).toMatch(/AFTER_UPSTREAM_NOT_FOUND/);
  });
});
