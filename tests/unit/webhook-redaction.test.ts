/* eslint-disable @typescript-eslint/no-explicit-any -- loose casts for response bodies */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '../../src/client.js';
import { redactRelayUrl, redactWebhookDeep, redactSmeeUrlsInText } from '../../src/utils/webhook-redact.js';
import { stripWebhookSecrets } from '../../src/share.js';
import { describeSchedule } from '../../src/utils/schedule-label.js';
import { redactForLlmValue } from '../../src/mcp/index.js';
import { startApiHarness, sampleJob, type ApiHarness } from '../helpers/api-harness.js';

const RELAY = 'https://smee.io/UkAbCdEfGhIjKlSd';
const REDACTED_RELAY = 'https://smee.io/Uk…Sd';
const SECRET = 'hunter2-hmac-secret';
const webhookJob = (extra: Record<string, unknown> = {}) =>
  sampleJob({ alias: 'hook', schedule: { kind: 'webhook', relay: RELAY, secret: SECRET }, ...extra });

describe('redaction helpers', () => {
  it('redactRelayUrl keeps origin + first/last 2 of the channel, idempotent', () => {
    expect(redactRelayUrl(RELAY)).toBe(REDACTED_RELAY);
    expect(redactRelayUrl(REDACTED_RELAY)).toBe(REDACTED_RELAY);
    expect(redactRelayUrl('https://smee.io/abc')).toBe('https://smee.io/…');
  });
  it('redactWebhookDeep redacts relay and sets secret: set, leaves other values', () => {
    const out = redactWebhookDeep({ a: [{ schedule: { kind: 'webhook', relay: RELAY, secret: SECRET } }], b: { kind: 'cron', cron: '* * * * *' } }) as any;
    expect(out.a[0].schedule).toEqual({ kind: 'webhook', relay: REDACTED_RELAY, secret: 'set' });
    expect(out.b).toEqual({ kind: 'cron', cron: '* * * * *' });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });
  it('redactSmeeUrlsInText masks smee channel urls in free text', () => {
    expect(redactSmeeUrlsInText(`Created relay channel ${RELAY} -- secret`)).toBe(`Created relay channel ${REDACTED_RELAY} -- secret`);
  });
  it('describeSchedule never prints the full relay', () => {
    const label = describeSchedule({ kind: 'webhook', relay: RELAY } as any, () => undefined);
    expect(label).toBe(`webhook (relay: ${REDACTED_RELAY})`);
  });
  it('stripWebhookSecrets removes relay and secret from webhook schedules only', () => {
    const rows = stripWebhookSecrets([{ schedule: { kind: 'webhook', relay: RELAY, secret: SECRET } }, { schedule: { kind: 'cron', cron: '* * * * *' } }]) as any[];
    expect(rows[0].schedule).toEqual({ kind: 'webhook' });
    expect(rows[1].schedule).toEqual({ kind: 'cron', cron: '* * * * *' });
  });
  it('MCP redactForLlmValue redacts relay/secret and smee urls in notices', () => {
    const out = redactForLlmValue({ result: { schedule: { kind: 'webhook', relay: RELAY, secret: SECRET } }, notices: [`Created ${RELAY}`] }) as any;
    expect(JSON.stringify(out)).not.toContain('UkAbCdEfGhIjKlSd');
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out.result.schedule.secret).toBe('set');
  });
});

describe('daemon API + client redaction', () => {
  let h: ApiHarness;
  beforeAll(async () => { h = await startApiHarness('webhook-redaction'); });
  afterAll(async () => { await h.close(); });

  it('list is redacted; get (full) and create response carry full values', async () => {
    const created = await h.call('POST', '/api/jobs', { ...webhookJob(), id: '11111111-1111-4111-8111-111111111111' });
    expect(created.status).toBe(201);
    expect(created.data.schedule).toEqual({ kind: 'webhook', relay: RELAY, secret: SECRET });
    const list = await h.call('GET', '/api/jobs');
    expect(list.data[0].schedule).toEqual({ kind: 'webhook', relay: REDACTED_RELAY, secret: 'set' });
    const get = await h.call('GET', '/api/jobs/hook');
    expect(get.data.schedule).toEqual({ kind: 'webhook', relay: RELAY, secret: SECRET });
    const dash = await h.call('GET', '/api/dashboard');
    expect(JSON.stringify(dash.data)).not.toContain('UkAbCdEfGhIjKlSd');
    expect(JSON.stringify(dash.data)).not.toContain(SECRET);
  });

  it('update response is redacted', async () => {
    const res = await h.call('PUT', '/api/jobs/hook', { description: 'changed' });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.data)).not.toContain('UkAbCdEfGhIjKlSd');
    expect(JSON.stringify(res.data)).not.toContain(SECRET);
  });

  it('PUT with a redacted schedule round-trip keeps the stored relay and secret', async () => {
    const list = await h.call('GET', '/api/jobs');
    const res = await h.call('PUT', '/api/jobs/hook', { schedule: list.data[0].schedule });
    expect(res.status).toBe(200);
    expect(h.store.getJob('hook')!.schedule).toEqual({ kind: 'webhook', relay: RELAY, secret: SECRET });
  });

  it('export strips relay/secret by default, keeps with includeSecrets', async () => {
    const stripped = await h.call('GET', '/api/export');
    expect(stripped.data.jobs[0].schedule).toEqual({ kind: 'webhook' });
    const kept = await h.call('GET', '/api/export?includeSecrets=1');
    expect(kept.data.jobs[0].schedule).toEqual({ kind: 'webhook', relay: RELAY, secret: SECRET });
  });

  it('client export/import honor includeSecrets', async () => {
    const client = createClient({ daemonUrl: h.baseUrl });
    const exp = await (client as any).exportJobs({ includeSecrets: true });
    expect(exp.jobs[0].schedule.relay).toBe(RELAY);
    const stripped = await (client as any).exportJobs();
    expect(stripped.jobs[0].schedule.relay).toBeUndefined();

    const file = { schema: 1, jobs: [{ ...webhookJob({ alias: 'imp-default' }) }, { ...webhookJob({ alias: 'imp-keep' }) }] };
    await (client as any).importJobs({ schema: 1, jobs: [file.jobs[0]] });
    await (client as any).importJobs({ schema: 1, jobs: [file.jobs[1]] }, { includeSecrets: true });
    expect(h.store.getJob('imp-default')!.schedule).toEqual({ kind: 'webhook' });
    expect(h.store.getJob('imp-keep')!.schedule).toEqual({ kind: 'webhook', relay: RELAY, secret: SECRET });
  });
});
