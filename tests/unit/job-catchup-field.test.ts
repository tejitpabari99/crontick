import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { JobSchema } from '../../src/schemas/job.js';
import { prepareCreate, prepareUpdate } from '../../src/job-prepare.js';
import { startApiHarness, sampleJob, type ApiHarness } from '../helpers/api-harness.js';

const action = { kind: 'prompt', prompt: 'hi', args: [], reuseSession: false, engine: 'raw' };
const base = { id: randomUUID(), schedule: { kind: 'interval', everySec: 60 }, action };
const nonTime = [
  { kind: 'after', jobId: randomUUID(), status: 'any' },
  { kind: 'webhook' },
];
const timeKinds = [
  { kind: 'cron', cron: '0 9 * * *' },
  { kind: 'interval', everySec: 60 },
  { kind: 'one-shot', runAt: '2030-01-01T09:00' },
];

describe('catchUp schema field', () => {
  it('defaults to false on jobs stored without it', () => {
    expect(JobSchema.parse(base).catchUp).toBe(false);
  });

  it.each(timeKinds)('accepts true for %o', (schedule) => {
    expect(JobSchema.parse({ ...base, schedule, catchUp: true }).catchUp).toBe(true);
  });

  it.each(nonTime)('rejects true for %o, accepts false', (schedule) => {
    const bad = JobSchema.safeParse({ ...base, schedule, catchUp: true });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.format())).toContain('catchUp');
    expect(JobSchema.parse({ ...base, schedule, catchUp: false }).catchUp).toBe(false);
  });
});

const catchUpError = expect.objectContaining({ code: 'VALIDATION_ERROR', details: expect.objectContaining({ catchUp: expect.anything() }) });

describe('catchUp prepare paths', () => {
  const input = { alias: 'cu', schedule: { kind: 'interval' as const, everySec: 60 }, action: { kind: 'prompt' as const, prompt: 'hi', args: [], reuseSession: false, engine: 'raw' as const } };
  it('create rejects catchUp on webhook, accepts on interval', () => {
    expect(prepareCreate({ ...input, catchUp: true }).catchUp).toBe(true);
    expect(() => prepareCreate({ ...input, schedule: { kind: 'webhook' }, catchUp: true })).toThrow(catchUpError);
  });
  it('update changing kind while flag on is rejected', () => {
    const existing = prepareCreate({ ...input, catchUp: true });
    expect(() => prepareUpdate(existing, { schedule: { kind: 'webhook' } })).toThrow(catchUpError);
  });
});

describe('catchUp API entry paths', () => {
  let h: ApiHarness;
  beforeAll(async () => { h = await startApiHarness('job-catchup-field'); });
  afterAll(async () => { await h.close(); });

  it('create: true ok for interval, rejected for webhook', async () => {
    const ok = await h.call('POST', '/api/jobs', sampleJob({ alias: `cu-${randomUUID().slice(0, 8)}`, catchUp: true }));
    expect(ok.status).toBe(201);
    expect(ok.data.catchUp).toBe(true);
    const bad = await h.call('POST', '/api/jobs', sampleJob({ schedule: { kind: 'webhook' }, catchUp: true }));
    expect(bad.status).toBe(400);
  });

  it('update: kind change with flag on rejected, flag-on update on webhook rejected', async () => {
    const job = (await h.call('POST', '/api/jobs', sampleJob({ alias: `cu-${randomUUID().slice(0, 8)}`, catchUp: true }))).data;
    const kind = await h.call('PUT', `/api/jobs/${job.id}`, { schedule: { kind: 'webhook' } });
    expect(kind.status).toBe(400);
    expect(h.store.getJob(job.id)?.schedule.kind).toBe('interval');
    const hook = (await h.call('POST', '/api/jobs', sampleJob({ alias: `wh-${randomUUID().slice(0, 8)}`, schedule: { kind: 'webhook' } }))).data;
    const flag = await h.call('PUT', `/api/jobs/${hook.id}`, { catchUp: true });
    expect(flag.status).toBe(400);
  });

  it('import: row with catchUp on webhook fails, valid row imports', async () => {
    const r = await h.call('POST', '/api/import', {
      jobs: [
        sampleJob({ id: randomUUID(), alias: `imp-${randomUUID().slice(0, 8)}`, schedule: { kind: 'webhook' }, catchUp: true }),
        sampleJob({ id: randomUUID(), alias: `imp-${randomUUID().slice(0, 8)}`, catchUp: true }),
      ],
    });
    const results = r.data.results ?? r.data;
    expect(results[0].ok).toBe(false);
    expect(results[1].ok).toBe(true);
  });
});
