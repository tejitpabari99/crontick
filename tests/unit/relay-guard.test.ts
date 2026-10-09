import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { RelayGuard, verifySignature, deliveryKey } from '../../src/daemon/relay-guard.js';
import { createLogger } from '../../src/logger.js';
import type { RelayDelivery } from '../../src/daemon/relay.js';
import {
  RELAY_DEDUPE_MAX_ENTRIES, RELAY_DEDUPE_TTL_MS, RELAY_RATE_LIMIT_PER_WINDOW, RELAY_RATE_WINDOW_MS,
} from '../../src/constants/relay.js';

const sign = (secret: string, body: unknown): string =>
  'sha256=' + createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');

let n = 0;
const ev = (over: Record<string, unknown> = {}, jobId = 'j1'): RelayDelivery => ({
  jobId, relayUrl: 'u', sseId: undefined, data: { 'x-github-delivery': `d${n++}`, body: { a: 1 }, ...over },
});

function setup(secret?: string) {
  const warns: string[] = [];
  const logger = createLogger({ verbose: true, component: 't', sink: (e) => { if (e.level === 'warn') warns.push(e.message); } });
  const recorded: Array<{ jobId: string; error: string; runId?: string }> = [];
  let seq = 0;
  const g = new RelayGuard({
    logger,
    getSecret: () => secret,
    recordRateLimited: (jobId, error, runId) => {
      recorded.push({ jobId, error, ...(runId ? { runId } : {}) });
      return runId ?? `run${++seq}`;
    },
  });
  return { g, recorded, warns };
}

describe('RelayGuard', () => {
  beforeEach(() => { vi.useFakeTimers(); n = 0; });
  afterEach(() => { vi.useRealTimers(); });

  describe('HMAC', () => {
    it('accepts a valid signature (top-level header)', () => {
      const { g } = setup('s3cret');
      expect(g.guard(ev({ 'x-hub-signature-256': sign('s3cret', { a: 1 }) }))).toBe(true);
    });
    it('accepts a valid signature in nested headers', () => {
      const { g } = setup('s3cret');
      expect(g.guard(ev({ headers: { 'X-Hub-Signature-256': sign('s3cret', { a: 1 }) } }))).toBe(true);
    });
    it('drops invalid signature with warn and counter', () => {
      const { g, warns } = setup('s3cret');
      expect(g.guard(ev({ 'x-hub-signature-256': sign('wrong', { a: 1 }) }))).toBe(false);
      expect(g.signatureRejected).toBe(1);
      expect(warns.length).toBeGreaterThan(0);
    });
    it('drops absent signature', () => {
      const { g } = setup('s3cret');
      expect(g.guard(ev())).toBe(false);
      expect(g.signatureRejected).toBe(1);
    });
    it('drops signature of different length without throwing', () => {
      expect(verifySignature('s', { a: 1 }, 'sha256=abc')).toBe(false);
    });
    it('skips verification when no secret is set', () => {
      const { g } = setup();
      expect(g.guard(ev())).toBe(true);
    });
  });

  describe('dedupe', () => {
    it('drops a repeated delivery id, per job', () => {
      const { g } = setup();
      const e = ev({ 'x-github-delivery': 'same' });
      expect(g.guard(e)).toBe(true);
      expect(g.guard(e)).toBe(false);
      expect(g.guard({ ...e, jobId: 'j2' })).toBe(true);
    });
    it('falls back to x-request-id then body hash', () => {
      expect(deliveryKey({ 'x-request-id': 'r1', body: {} })).toBe('r1');
      const a = deliveryKey({ body: { x: 1 }, timestamp: 1 });
      expect(a).toBe(deliveryKey({ body: { x: 1 }, timestamp: 2 }));
      expect(a).not.toBe(deliveryKey({ body: { x: 2 } }));
    });
    it('forgets ids after the TTL', () => {
      const { g } = setup();
      const e = ev({ 'x-github-delivery': 'same' });
      g.guard(e);
      vi.setSystemTime(Date.now() + RELAY_DEDUPE_TTL_MS + 1);
      expect(g.guard(e)).toBe(true);
    });
    it('evicts the least recently used id beyond the cap', () => {
      const { g } = setup();
      const first = ev({ 'x-github-delivery': 'first' });
      g.guard(first);
      for (let i = 0; i < RELAY_DEDUPE_MAX_ENTRIES; i++) {
        vi.advanceTimersByTime(1000);
        g.guard(ev({ 'x-github-delivery': `f${i}` }));
        if (i % 6 === 5) vi.advanceTimersByTime(RELAY_RATE_WINDOW_MS); // keep bucket full
      }
      expect(g.guard(first)).toBe(true); // evicted, so accepted again
    });
  });

  describe('burst limit', () => {
    it('drops the 11th event and records one skipped run, then updates its count', () => {
      const { g, recorded } = setup();
      for (let i = 0; i < RELAY_RATE_LIMIT_PER_WINDOW; i++) expect(g.guard(ev())).toBe(true);
      expect(g.guard(ev())).toBe(false);
      expect(recorded).toEqual([{ jobId: 'j1', error: 'RATE_LIMITED (1 dropped)' }]);
      expect(g.guard(ev())).toBe(false);
      expect(recorded).toHaveLength(2);
      expect(recorded[1]).toEqual({ jobId: 'j1', error: 'RATE_LIMITED (2 dropped)', runId: 'run1' });
    });
    it('opens a new skipped run in the next window and refills tokens', () => {
      const { g, recorded } = setup();
      for (let i = 0; i < 11; i++) g.guard(ev());
      vi.advanceTimersByTime(RELAY_RATE_WINDOW_MS);
      expect(g.guard(ev())).toBe(true);
      for (let i = 0; i < 12; i++) g.guard(ev());
      const fresh = recorded.filter((r) => r.runId === undefined);
      expect(fresh).toHaveLength(2);
    });
    it('limits jobs independently', () => {
      const { g } = setup();
      for (let i = 0; i < 11; i++) g.guard(ev());
      expect(g.guard(ev({}, 'j2'))).toBe(true);
    });
  });

});
