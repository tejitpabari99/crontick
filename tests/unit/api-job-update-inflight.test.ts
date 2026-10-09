import { describe, expect, it } from 'vitest';
import { sampleJob, startApiHarness } from '../helpers/api-harness.js';

describe('PUT /api/jobs/:id with runs in flight', () => {
  async function setup(extra: Record<string, unknown> = {}) {
    const calls: string[] = [];
    let alive = true;
    const h = await startApiHarness('api-job-update-inflight', {
      listInFlight: ((jobId?: string) => (alive && (jobId === undefined || jobId === h.jobId) ? [{ runId: 'r1', jobId: h.jobId }] : [])) as never,
      cancelAllInFlight: (async (_reason?: string, jobId?: string) => { calls.push(`cancel:${jobId}`); alive = false; }) as never,
      waitForIdle: (async (jobId?: string) => { calls.push(`wait:${jobId}`); alive = false; }) as never,
      ...extra,
    }) as Awaited<ReturnType<typeof startApiHarness>> & { jobId: string };
    const created = await h.call('POST', '/api/jobs', sampleJob({ alias: 'busy' }));
    h.jobId = created.data.id;
    return { h, calls };
  }

  it('409 RUNS_IN_FLIGHT listing runs when no choice; job unchanged', async () => {
    const { h, calls } = await setup();
    try {
      const r = await h.call('PUT', '/api/jobs/busy', { description: 'new' });
      expect(r.status).toBe(409);
      expect(r.data.error.code).toBe('RUNS_IN_FLIGHT');
      expect(r.data.error.details.runs).toEqual([{ runId: 'r1', jobId: h.jobId }]);
      expect(calls).toEqual([]);
      expect((await h.call('GET', '/api/jobs/busy')).data.description).toBe('sample');
    } finally {
      await h.close();
    }
  });

  it('inFlight=stop cancels this job\'s runs then applies in one request', async () => {
    const { h, calls } = await setup();
    try {
      const r = await h.call('PUT', '/api/jobs/busy?inFlight=stop', { ...sampleJob(), description: 'new' });
      expect(r.status).toBe(200);
      expect(r.data.description).toBe('new');
      expect(calls).toEqual([`cancel:${h.jobId}`]);
    } finally {
      await h.close();
    }
  });

  it('inFlight=wait waits for this job then applies; also works in prepare mode', async () => {
    const { h, calls } = await setup();
    try {
      const r = await h.call('PUT', '/api/jobs/busy?inFlight=wait&prepare=1', { description: 'waited' });
      expect(r.status).toBe(200);
      expect(r.data.description).toBe('waited');
      expect(calls).toEqual([`wait:${h.jobId}`]);
    } finally {
      await h.close();
    }
  });

  it('invalid body or choice cancels nothing', async () => {
    const { h, calls } = await setup();
    try {
      const badChoice = await h.call('PUT', '/api/jobs/busy?inFlight=later', { description: 'x' });
      expect(badChoice.status).toBe(400);
      const badJob = await h.call('PUT', '/api/jobs/busy?inFlight=stop', { schedule: { kind: 'nope' } });
      expect(badJob.status).toBe(400);
      expect(calls).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('updates without runs in flight need no choice', async () => {
    const h = await startApiHarness('api-job-update-idle');
    try {
      const created = await h.call('POST', '/api/jobs', sampleJob({ alias: 'idle' }));
      const r = await h.call('PUT', `/api/jobs/${created.data.id}`, { ...sampleJob(), description: 'ok' });
      expect(r.status).toBe(200);
    } finally {
      await h.close();
    }
  });

  async function blockedWait(mutate: (h: Awaited<ReturnType<typeof setup>>['h']) => Promise<void>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { h } = await setup({ waitForIdle: (async () => { await gate; }) as never });
    const pending = h.call('PUT', '/api/jobs/busy?inFlight=wait&prepare=1', { description: 'late' });
    await new Promise((r) => setTimeout(r, 50));
    await mutate(h);
    release();
    return { h, res: await pending };
  }

  it('inFlight=wait: job deleted while waiting -> 404, not resurrected', async () => {
    const { h, res } = await blockedWait(async (hh) => { await hh.call('DELETE', '/api/jobs/busy'); });
    try {
      expect(res.status).toBe(404);
      expect((await h.call('GET', '/api/jobs')).data).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('inFlight=wait: job edited while waiting -> 409 JOB_CHANGED, edit kept', async () => {
    const { h, res } = await blockedWait(async (hh) => { const cur = hh.store.getJob('busy')!; hh.store.upsertJob({ ...cur, description: 'other' }); });
    try {
      expect(res.status).toBe(409);
      expect(res.data.error.code).toBe('JOB_CHANGED');
      const now = (await h.call('GET', '/api/jobs/busy')).data;
      expect(now.description).toBe('other');
    } finally {
      await h.close();
    }
  });

  it('inFlight=stop uses a job-update cancel reason', async () => {
    const reasons: Array<string | undefined> = [];
    let alive = true;
    const { h } = await setup({
      listInFlight: (() => (alive ? [{ runId: 'r1', jobId: 'x' }] : [])) as never,
      cancelAllInFlight: (async (reason?: string) => { reasons.push(reason); alive = false; }) as never,
    });
    try {
      const r = await h.call('PUT', '/api/jobs/busy?inFlight=stop&prepare=1', { description: 'n' });
      expect(r.status).toBe(200);
      expect(reasons).toEqual(['canceled: job update stopped in-flight runs']);
    } finally {
      await h.close();
    }
  });
});
