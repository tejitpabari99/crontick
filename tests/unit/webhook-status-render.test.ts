/** SP06 Task 8: relay status API, `runs get` trigger rendering, doctor relay check. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApiHarness, sampleJob, type ApiHarness } from '../helpers/api-harness.js';
import { formatRunDetail, formatRelayStatusLine } from '../../src/run-format.js';
import { relayDoctorChecks } from '../../src/doctor.js';
import type { RunRecord } from '../../src/client.js';

const out = { error: null, result: null, stderr: '' };
const baseRun: RunRecord = { id: 'r1', jobId: 'j1', startedAt: Date.UTC(2026, 8, 29, 4, 0, 0), status: 'success', outputTruncated: false };

describe('runs get trigger rendering', () => {
  it('shows source, time, delivery id and payload for webhook runs', () => {
    const text = formatRunDetail({ ...baseRun, trigger: { source: 'relay', deliveryId: 'd-123', receivedAt: '2026-09-29T04:00:00.000Z', payload: '{"a":1}' } }, out);
    expect(text).toContain('Triggered by webhook (relay) at 2026-09-29T04:00:00.000Z, delivery d-123');
    expect(text).toContain('Payload: {"a":1}');
  });
  it('omits delivery for local triggers and renders nothing without trigger', () => {
    const text = formatRunDetail({ ...baseRun, trigger: { source: 'local', receivedAt: '2026-09-29T04:00:00.000Z', payload: '{}' } }, out);
    expect(text).toContain('Triggered by webhook (local) at 2026-09-29T04:00:00.000Z');
    expect(text).not.toContain('delivery');
    expect(formatRunDetail(baseRun, out)).not.toContain('Triggered by');
  });
});

describe('formatRelayStatusLine', () => {
  it('summarizes state, events and error', () => {
    const line = formatRelayStatusLine({ urlRedacted: 'https://smee.io/ab…yz', state: 'backoff', lastEventAt: null, lastError: 'boom', eventCount: 2, jobIds: ['j1'] });
    expect(line).toContain('https://smee.io/ab…yz');
    expect(line).toContain('backoff');
    expect(line).toContain('events=2');
    expect(line).toContain('boom');
  });
});

describe('relayDoctorChecks', () => {
  const s = (state: string, lastError: string | null) => ({ urlRedacted: 'https://smee.io/ab…yz', state, lastEventAt: null, lastError, eventCount: 0, jobIds: [] });
  it('is ok for connected and WARN (still ok:true) for errors', () => {
    const [good, bad] = relayDoctorChecks([s('connected', null) as never, s('backoff', 'ECONNRESET') as never]);
    expect(good).toMatchObject({ name: 'relay: https://smee.io/ab…yz', ok: true });
    expect(good.warn).toBeUndefined();
    expect(bad).toMatchObject({ ok: true, warn: true });
    expect(bad.note).toContain('ECONNRESET');
  });
  it('returns nothing without relays', () => { expect(relayDoctorChecks([])).toEqual([]); });
});

describe('API', () => {
  let h: ApiHarness;
  beforeAll(async () => { h = await startApiHarness('webhook-status'); });
  afterAll(async () => { await h.close(); });
  it('GET /api/runs/:id includes parsed trigger with smee URLs redacted', async () => {
    const jobId = (await h.call('POST', '/api/jobs', sampleJob({ alias: 'wh-trig' }))).data.id as string;
    const runId = h.store.insertRun(jobId).id;
    h.store.setRunTrigger(runId, { source: 'relay', deliveryId: 'd1', receivedAt: 'x', payload: '{"u":"https://smee.io/AbCdEfGhIjKl"}' });
    const run = (await h.call('GET', `/api/runs/${runId}`)).data;
    expect(run.trigger.deliveryId).toBe('d1');
    expect(run.trigger.payload).not.toContain('AbCdEfGhIjKl');
  });
  it('GET /api/runs/:id has no trigger for plain runs', async () => {
    const jobId = (await h.call('POST', '/api/jobs', sampleJob({ alias: 'plain' }))).data.id as string;
    const run = (await h.call('GET', `/api/runs/${h.store.insertRun(jobId).id}`)).data;
    expect(run.trigger).toBeUndefined();
  });
  it('GET /api/relays returns [] without a relay manager', async () => {
    expect((await h.call('GET', '/api/relays')).data).toEqual([]);
  });
});

import { toRelayStatusView } from '../../src/utils/webhook-redact.js';
describe('toRelayStatusView', () => {
  it('redacts the url and smee urls in lastError', () => {
    const v = toRelayStatusView({ url: 'https://smee.io/AbCdEfGhIjKl', state: 'error', jobIds: ['j'], lastEventAt: null, lastError: 'fail https://smee.io/AbCdEfGhIjKl', eventCount: 0 });
    expect(JSON.stringify(v)).not.toContain('AbCdEfGhIjKl');
    expect(v.urlRedacted).toBe('https://smee.io/Ab…Kl');
  });
});
