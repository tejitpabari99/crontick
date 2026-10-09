/** Dashboard webhook kind (SP06 Task 9): registry entry, /api/relay/new, drawer + run-log wiring (asset-level). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startApiHarness, type ApiHarness } from '../helpers/api-harness.js';

const read = (f: string): string => readFileSync(resolve('src/dashboard', f), 'utf-8');
const js = read('dashboard.js');
const html = read('index.html');
const css = read('dashboard.css');

type Values = Record<string, string>;
interface Kind {
  kind: string; label: string; help?: string;
  fields: Array<{ id: string; type: string; button?: { label: string; act: string } }>;
  toSchedule(v: Values): Record<string, unknown> | null;
  fromSchedule(s: Record<string, unknown>): Values;
}
const escHtmlSrc = /function escHtml\(value\) \{[\s\S]*?\n\}\n/.exec(js)![0];
const pure = new Function(`${escHtmlSrc}\n${/\/\/ <editor-pure>([\s\S]*?)\/\/ <\/editor-pure>/.exec(js)![1]}; return { SCHEDULE_KINDS, renderTriggerHtml };`)() as {
  SCHEDULE_KINDS: Kind[];
  renderTriggerHtml(t: unknown): string;
};
const webhook = pure.SCHEDULE_KINDS.find((k) => k.kind === 'webhook')!;

describe('webhook schedule kind', () => {
  it('has relay text (with Create channel button) and secret password fields', () => {
    expect(webhook.label).toMatch(/webhook/i);
    const relay = webhook.fields.find((f) => f.id === 'relay')!;
    expect(relay.type).toBe('text');
    expect(relay.button?.act).toBe('create-relay');
    expect(relay.button?.label).toBe('Create channel');
    expect(webhook.fields.find((f) => f.id === 'secret')!.type).toBe('password');
  });
  it('toSchedule omits blank relay/secret (local-trigger-only is valid)', () => {
    expect(webhook.toSchedule({ relay: '', secret: '' })).toEqual({ kind: 'webhook' });
    expect(webhook.toSchedule({ relay: ' https://smee.io/abc ', secret: 's3' })).toEqual({ kind: 'webhook', relay: 'https://smee.io/abc', secret: 's3' });
  });
  it('fromSchedule prefills (masked values round-trip unchanged)', () => {
    expect(webhook.fromSchedule({ kind: 'webhook', relay: 'https://smee.io/Uk…Sd', secret: 'set' })).toEqual({ relay: 'https://smee.io/Uk…Sd', secret: 'set' });
    expect(webhook.fromSchedule({ kind: 'webhook' })).toEqual({ relay: '', secret: '' });
  });
  it('every kind carries How-to-schedule help, rendered in a footer', () => {
    for (const k of pure.SCHEDULE_KINDS) expect(k.help, k.kind).toBeTruthy();
    expect(js).toContain('How to schedule');
    expect(webhook.help).toMatch(/webhook/i);
  });
});

describe('dashboard wiring', () => {
  it('Create channel calls POST /api/relay/new', () => {
    expect(js).toContain("'/api/relay/new'");
    expect(js).toContain('create-relay');
  });
  it('status dot matches the relay by job id, not only by redacted URL text', () => {
    expect(js).toContain('r.jobIds.includes(jobId)');
    expect(js).toContain('relayRowHtml(job.schedule, relays, job.id)');
  });
  it('drawer shows read-only relay, Copy fetching the full job, status dot, Trigger now', () => {
    expect(js).toContain('/api/relays');
    expect(js).toContain('relay-dot');
    expect(js).toContain('data-drawer-action="copy-relay"');
    expect(js).toMatch(/copy-relay[\s\S]{0,400}\/api\/jobs\/\$\{encodeURIComponent/);
    expect(js).toContain('data-drawer-action="trigger"');
    expect(js).toContain('drawer-trigger-payload');
    expect(js).toMatch(/\/trigger`/);
    expect(css).toContain('.relay-dot');
  });
  it('run-log modal has a trigger section with collapsible payload', () => {
    expect(html).toContain('id="modal-trigger-section"');
    expect(js).toContain('renderTriggerHtml');
  });
});

describe('renderTriggerHtml', () => {
  it('shows source, delivery id, and collapsible pretty JSON payload', () => {
    const out = pure.renderTriggerHtml({ source: 'relay', deliveryId: 'd-1', receivedAt: '2026-10-01T00:00:00Z', payload: '{"body":{"a":1}}' });
    expect(out).toContain('relay');
    expect(out).toContain('d-1');
    expect(out).toContain('<details');
    expect(out).toContain('&quot;a&quot;: 1');
  });
  it('escapes HTML and tolerates non-JSON payload text', () => {
    const out = pure.renderTriggerHtml({ source: '<b>x</b>', receivedAt: 'now', payload: '<script>' });
    expect(out).not.toContain('<b>x</b>');
    expect(out).not.toContain('<script>');
  });
});

describe('POST /api/relay/new', () => {
  let h: ApiHarness;
  let calls = 0;
  beforeAll(async () => {
    const relayFetch = (async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: 'https://smee.io/AbCdEf123' } });
    }) as unknown as typeof fetch;
    h = await startApiHarness('dashboard-webhook', undefined, { relayFetch });
  });
  afterAll(async () => { await h.close(); });

  it('returns the created channel url via the injected fetch', async () => {
    const r = await h.call('POST', '/api/relay/new', {});
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ url: 'https://smee.io/AbCdEf123' });
    expect(calls).toBe(1);
  });
  it('is rejected by the request guard without JSON content type', async () => {
    const res = await fetch(`${h.baseUrl}/api/relay/new`, { method: 'POST' });
    expect(res.status).toBe(415);
  });
});
