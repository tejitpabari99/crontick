/** Dashboard payload: job working directory, and runs of a deleted job disappearing from `/api/dashboard`. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, sampleJob, type ApiHarness } from '../helpers/api-harness.js';

let h: ApiHarness;
beforeAll(async () => { h = await startApiHarness('dashboard-job-display'); });
afterAll(async () => { await h.close(); });

describe('GET /api/dashboard job fields', () => {
  it('exposes the job working directory as cwd (null when unset)', async () => {
    const withCwd = await h.call('POST', '/api/jobs', sampleJob({ alias: 'with-cwd', action: { kind: 'prompt', prompt: 'x', args: [], reuseSession: false, cwd: '/tmp' } }));
    const without = await h.call('POST', '/api/jobs', sampleJob({ alias: 'no-cwd' }));
    const { data } = await h.call('GET', '/api/dashboard');
    const byId = new Map((data.jobs as Array<{ id: string; cwd: string | null; alias: string }>).map((j) => [j.id, j]));
    expect(byId.get(withCwd.data.id)?.cwd).toBe('/tmp');
    expect(byId.get(without.data.id)?.cwd).toBeNull();
  });

  it('regression: deleting a job via the API leaves none of its runs in /api/dashboard', async () => {
    const created = await h.call('POST', '/api/jobs', sampleJob({ alias: 'to-delete' }));
    const jobId = created.data.id as string;
    const runId = h.store.insertRun(jobId).id;
    const before = await h.call('GET', '/api/dashboard?runsLimit=500');
    expect((before.data.runs as Array<{ id: string }>).some((r) => r.id === runId)).toBe(true);
    expect((await h.call('DELETE', `/api/jobs/${jobId}`)).status).toBeLessThan(300);
    const after = await h.call('GET', '/api/dashboard?runsLimit=500');
    expect((after.data.runs as Array<{ jobId: string }>).some((r) => r.jobId === jobId)).toBe(false);
    expect((await h.call('GET', `/api/runs?jobId=${jobId}`)).data).toEqual([]);
  });
});
