import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateAlias } from '../../src/job-input.js';
import { CrontickError } from '../../src/errors.js';
import { startApiHarness, sampleJob, type ApiHarness } from '../helpers/api-harness.js';

describe('generateAlias fallback', () => {
  it('falls back to a <word>-<6 char base36> alias after numeric suffixes are exhausted', () => {
    const numeric = /^dune-\d+$/;
    const alias = generateAlias((candidate) => numeric.test(candidate), { words: ['dune'], random: () => 0 });
    expect(alias).toMatch(/^dune-[0-9a-z]{6}$/);
    expect(numeric.test(alias)).toBe(false);
  });

  it('still throws ALIAS_GENERATION_FAILED when every candidate is taken', () => {
    expect(() => generateAlias(() => true, { words: ['dune'], random: () => 0 })).toThrow(CrontickError);
  });
});

describe('alias in the daemon API', () => {
  let h: ApiHarness | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await h?.close();
    h = undefined;
  });

  it('resolves id or alias on every job route and says "id or alias" when missing', async () => {
    h = await startApiHarness('alias-term');
    const created = await h.call('POST', '/api/jobs', sampleJob({ alias: 'route-job' }));
    expect(created.status).toBe(201);
    const id = created.data.id as string;
    for (const key of [id, 'route-job']) {
      expect((await h.call('GET', `/api/jobs/${key}`)).data.id).toBe(id);
      expect((await h.call('GET', `/api/stats/jobs/${key}`)).status).toBe(200);
      expect((await h.call('GET', `/api/runs?jobId=${key}`)).status).toBe(200);
      expect((await h.call('POST', `/api/jobs/${key}/disable`)).status).toBe(200);
      expect((await h.call('POST', `/api/jobs/${key}/enable`)).status).toBe(200);
      const put = await h.call('PUT', `/api/jobs/${key}`, { description: `via ${key}` });
      expect(put.status).toBe(200);
      expect((await h.call('POST', `/api/jobs/${key}/run`)).status).toBe(202);
    }
    const missing = await h.call('GET', '/api/jobs/nope');
    expect(missing.status).toBe(404);
    expect(missing.data.error.message).toBe('Job nope not found (id or alias)');
    expect((await h.call('DELETE', '/api/jobs/route-job')).status).toBe(200);
  });

  it('regenerates an auto alias when the UNIQUE index rejects a raced create', async () => {
    h = await startApiHarness('alias-race');
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect((await h.call('POST', '/api/jobs', sampleJob({ alias: 'atlas-1' }))).status).toBe(201);
    let lie = true;
    const realGet = h.store.getJob.bind(h.store);
    vi.spyOn(h.store, 'getJob').mockImplementation((key: string) => (lie && key === 'atlas-1' ? undefined : realGet(key)));
    const realUpsert = h.store.upsertJob.bind(h.store);
    vi.spyOn(h.store, 'upsertJob').mockImplementation((job) => {
      try { return realUpsert(job); } catch (err) { lie = false; throw err; }
    });
    const res = await h.call('POST', '/api/jobs', sampleJob());
    expect(res.status).toBe(201);
    expect(res.data.alias).not.toBe('atlas-1');
    expect(res.data.alias).toMatch(/^atlas-/);
    expect(h.store.listJobs()).toHaveLength(2);
  });

  it('keeps JOB_ALREADY_EXISTS for an explicit alias', async () => {
    h = await startApiHarness('alias-explicit');
    await h.call('POST', '/api/jobs', sampleJob({ alias: 'dup-job' }));
    const dup = await h.call('POST', '/api/jobs', sampleJob({ alias: 'dup-job' }));
    expect(dup.status).toBe(409);
    expect(dup.data.error.code).toBe('JOB_ALREADY_EXISTS');
  });
});
