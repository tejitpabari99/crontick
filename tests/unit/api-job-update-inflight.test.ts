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
});
