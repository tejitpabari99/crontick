/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { ScheduleSchema, isTimeSchedule } from '../../src/schemas/job.js';
import { buildJobFromCreateOptions, buildJobPatchFromUpdateOptions, JobCreateInputSchema } from '../../src/job-input.js';
import { SCHEDULE_FLAGS, scheduleFooter } from '../../src/constants/cli-schedule.js';
import { describeSchedule } from '../../src/utils/schedule-label.js';
import { createRelayChannel } from '../../src/utils/relay-url.js';
import { createClient } from '../../src/client.js';
import { Scheduler } from '../../src/daemon/scheduler.js';

const base = { prompt: 'p', cwd: '/tmp' };
const opts = { cwd: '/tmp' };

describe('WebhookScheduleSchema', () => {
  it('accepts webhook with and without relay/secret', () => {
    expect(ScheduleSchema.safeParse({ kind: 'webhook' }).success).toBe(true);
    expect(ScheduleSchema.safeParse({ kind: 'webhook', relay: 'https://smee.io/abc', secret: 's' }).success).toBe(true);
  });
  it('allows http only for loopback hosts', () => {
    for (const relay of ['http://127.0.0.1:9/x', 'http://localhost/x', 'http://[::1]:3000/x']) {
      expect(ScheduleSchema.safeParse({ kind: 'webhook', relay }).success).toBe(true);
    }
    for (const relay of ['http://smee.io/x', 'ftp://smee.io/x', 'not a url', '']) {
      expect(ScheduleSchema.safeParse({ kind: 'webhook', relay }).success).toBe(false);
    }
  });
  it('rejects mixing with other kinds fields (exclusive kind)', () => {
    expect(ScheduleSchema.safeParse({ kind: 'webhook', cron: '* * * * *' } as any).success).toBe(true); // unknown keys stripped, kind decides
    expect(ScheduleSchema.parse({ kind: 'webhook', cron: '* * * * *' } as any)).toEqual({ kind: 'webhook' });
    expect(ScheduleSchema.safeParse({ kind: 'cron', cron: '* * * * *', relay: 'https://x.io/a' }).success).toBe(true);
  });
  it('is not a time schedule; previewNext and enumerateFiresBetween are empty', () => {
    const s = ScheduleSchema.parse({ kind: 'webhook' });
    expect(isTimeSchedule(s)).toBe(false);
    const sched = new Scheduler();
    expect(sched.previewNext(s)).toEqual([]);
    expect(sched.enumerateFiresBetween(s, 0, 1e12)).toEqual({ fires: [], capped: false });
    expect(sched.validateSchedule(s)).toEqual({ ok: true });
  });
  it('JobCreateInput accepts a webhook schedule', () => {
    const r = JobCreateInputSchema.safeParse({ schedule: { kind: 'webhook' }, action: { kind: 'prompt', prompt: 'x' } });
    expect(r.success).toBe(true);
  });
});

describe('describeSchedule webhook', () => {
  it('labels relay and local-only', () => {
    expect(describeSchedule({ kind: 'webhook', relay: 'https://smee.io/abc' }, () => undefined)).toBe('webhook (relay: https://smee.io/abc)');
    expect(describeSchedule({ kind: 'webhook' }, () => undefined)).toBe('webhook (local only)');
  });
});

describe('webhook CLI option building', () => {
  it('builds webhook schedules', () => {
    expect((buildJobFromCreateOptions({ ...base, webhook: true }, opts) as any).schedule).toEqual({ kind: 'webhook' });
    expect((buildJobFromCreateOptions({ ...base, webhook: true, relay: 'https://smee.io/a', webhookSecret: 's' }, opts) as any).schedule)
      .toEqual({ kind: 'webhook', relay: 'https://smee.io/a', secret: 's' });
    expect(buildJobPatchFromUpdateOptions({ webhook: true }, opts).schedule).toEqual({ kind: 'webhook' });
  });
  it('--relay / --webhook-secret without --webhook are errors', () => {
    expect(() => buildJobFromCreateOptions({ ...base, cron: '* * * * *', relay: 'https://smee.io/a' }, opts)).toThrow(/--relay requires --webhook/);
    expect(() => buildJobFromCreateOptions({ ...base, cron: '* * * * *', webhookSecret: 's' }, opts)).toThrow(/--webhook-secret requires --webhook/);
    expect(() => buildJobPatchFromUpdateOptions({ relay: 'https://smee.io/a' }, opts)).toThrow(/--relay requires --webhook/);
  });
  it('--webhook with another schedule flag is an error', () => {
    expect(() => buildJobFromCreateOptions({ ...base, webhook: true, cron: '* * * * *' }, opts)).toThrow(/only one schedule/);
    expect(() => buildJobFromCreateOptions({ ...base, webhook: true, after: 'x' }, opts)).toThrow(/only one schedule/);
  });
  it('invalid relay url is rejected', () => {
    expect(() => buildJobFromCreateOptions({ ...base, webhook: true, relay: 'http://evil.example/x' }, opts)).toThrow();
  });
  it('unresolved --relay auto is rejected by the sync builder', () => {
    expect(() => buildJobFromCreateOptions({ ...base, webhook: true, relay: 'auto' }, opts)).toThrow(/auto/);
  });
  it('--webhook is in SCHEDULE_FLAGS and the footer', () => {
    expect(SCHEDULE_FLAGS.map((f) => f.flag)).toContain('--webhook');
    expect(scheduleFooter()).toContain('--webhook');
  });
});

describe('--relay auto', () => {
  const redirect = (status: number, location?: string) => vi.fn(async () => new Response(null, { status, headers: location ? { location } : {} }));

  it('createRelayChannel returns the Location without following redirects', async () => {
    const f = redirect(307, 'https://smee.io/Abc123');
    expect(await createRelayChannel(f as any)).toBe('https://smee.io/Abc123');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://smee.io/new');
    expect(init.redirect).toBe('manual');
  });
  it('fails on non-redirect, missing or invalid Location, and network error', async () => {
    await expect(createRelayChannel(redirect(200) as any)).rejects.toThrow(/expected a redirect/);
    await expect(createRelayChannel(redirect(307) as any)).rejects.toThrow(/expected a redirect/);
    await expect(createRelayChannel(redirect(307, 'http://evil.example/x') as any)).rejects.toThrow(/invalid redirect/);
    await expect(createRelayChannel((async () => { throw new Error('down'); }) as any)).rejects.toThrow(/down/);
  });
  it('client resolves --relay auto with injected fetch and emits a one-time secret notice', async () => {
    const f = redirect(307, 'https://smee.io/Zzz999');
    const client = createClient({ relayFetch: f as any, startDaemon: false });
    const resolved = await client.resolveRelayAuto({ webhook: true, relay: 'auto' });
    expect(resolved.relay).toBe('https://smee.io/Zzz999');
    expect(client.drainNotices().join('\n')).toMatch(/https:\/\/smee\.io\/Zzz999.*secret/s);
    expect(await client.resolveRelayAuto({ webhook: true, relay: 'https://smee.io/x' })).toEqual({ webhook: true, relay: 'https://smee.io/x' });
    expect(await client.resolveRelayAuto({ webhook: true })).toEqual({ webhook: true });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('does not call fetch for --relay auto without --webhook', async () => {
    const f = redirect(307, 'https://smee.io/Zzz999');
    const client = createClient({ relayFetch: f as any, startDaemon: false });
    await expect(client.resolveRelayAuto({ relay: 'auto' })).rejects.toThrow(/--relay requires --webhook/);
    expect(f).not.toHaveBeenCalled();
  });
});
