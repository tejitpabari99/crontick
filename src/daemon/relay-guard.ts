/**
 * Relay-path-only event guards (SP06 R7-R9, D7): HMAC verification, per-job delivery-id
 * dedupe (LRU + TTL) and a per-job token-bucket burst limit. Local triggers never pass
 * through here. Plugs into RelayManager's `guard` seam; order is verify -> dedupe -> rate.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Logger } from '../logger.js';
import {
  RELAY_DEDUPE_MAX_ENTRIES,
  RELAY_DEDUPE_TTL_MS,
  RELAY_RATE_LIMITED_ERROR,
  RELAY_RATE_LIMIT_PER_WINDOW,
  RELAY_RATE_WINDOW_MS,
} from '../constants/relay.js';
import { flattenRelayHeaders } from '../utils/webhook-payload.js';
import type { RelayDelivery } from './relay.js';

export interface RelayGuardDeps {
  logger: Logger;
  /** The job's configured HMAC secret, if any (looked up per event so edits apply live). */
  getSecret: (jobId: string) => string | undefined;
  /**
   * Records (id undefined) or updates (id given) the single `skipped` run for a rate-limit
   * window; returns the run id.
   */
  recordRateLimited: (jobId: string, error: string, runId: string | undefined, atMs: number) => string;
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}
interface Window {
  startedAt: number;
  dropped: number;
  runId: string;
}

function headerValue(data: Record<string, unknown>, name: string): string | undefined {
  return flattenRelayHeaders(data)[name];
}

/** True when `sig` equals `sha256=` + HMAC-SHA256(secret, JSON.stringify(body)). */
export function verifySignature(secret: string, body: unknown, sig: string | undefined): boolean {
  if (!sig) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(JSON.stringify(body) ?? '').digest('hex'));
  const got = Buffer.from(sig);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * Dedupe key. Signed jobs (`signature` given, already verified): the signature itself, because the
 * delivery-id headers are NOT covered by the HMAC and a replayed signed body could carry a fresh id.
 * Otherwise x-github-delivery, else x-request-id, else sha256 of the body (timestamp-less).
 */
export function deliveryKey(data: Record<string, unknown>, signature?: string): string {
  if (signature !== undefined) return 'sig:' + signature;
  return (
    headerValue(data, 'x-github-delivery') ??
    headerValue(data, 'x-request-id') ??
    'body:' + createHash('sha256').update(JSON.stringify(data['body']) ?? '').digest('hex')
  );
}

export class RelayGuard {
  private readonly now: () => number;
  private readonly seen = new Map<string, Map<string, number>>(); // jobId -> key -> seenAt (insertion = LRU order)
  private readonly buckets = new Map<string, Bucket>();
  private readonly windows = new Map<string, Window>();
  /** Counter of events dropped for a bad/absent signature (R7). */
  signatureRejected = 0;

  constructor(private readonly deps: RelayGuardDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** RelayManager `guard` seam: true = dispatch, false = drop. */
  guard = (d: RelayDelivery): boolean => {
    const secret = this.deps.getSecret(d.jobId);
    const signature = headerValue(d.data, 'x-hub-signature-256');
    if (secret !== undefined && !verifySignature(secret, d.data['body'], signature)) {
      this.signatureRejected++;
      this.deps.logger.warn('Relay event dropped: missing or invalid signature', { jobId: d.jobId });
      return false;
    }
    const key = deliveryKey(d.data, secret !== undefined ? signature : undefined);
    if (this.isDuplicate(d.jobId, key)) {
      this.deps.logger.debug('Relay event dropped: duplicate delivery', { jobId: d.jobId });
      return false;
    }
    // Remember the key only once the event is admitted, so a burst-dropped event can be redelivered.
    if (!this.takeToken(d.jobId)) return false;
    this.remember(d.jobId, key);
    return true;
  };

  /** Releases state for every job not in `activeJobIds` (deleted, disabled or no longer relayed). */
  retain(activeJobIds: ReadonlySet<string>): void {
    for (const id of new Set([...this.seen.keys(), ...this.buckets.keys(), ...this.windows.keys()])) {
      if (!activeJobIds.has(id)) this.forget(id);
    }
  }

  forget(jobId: string): void {
    this.seen.delete(jobId);
    this.buckets.delete(jobId);
    this.windows.delete(jobId);
  }

  /** True when `key` was admitted within the TTL (refreshing its LRU position); never records. */
  private isDuplicate(jobId: string, key: string): boolean {
    const now = this.now();
    const m = this.seen.get(jobId);
    if (!m) return false;
    for (const [k, at] of m) {
      if (now - at < RELAY_DEDUPE_TTL_MS) break; // insertion order == age order
      m.delete(k);
    }
    if (m.has(key)) {
      m.delete(key);
      m.set(key, now); // refresh LRU position
      return true;
    }
    return false;
  }

  private remember(jobId: string, key: string): void {
    let m = this.seen.get(jobId);
    if (!m) this.seen.set(jobId, (m = new Map()));
    m.set(key, this.now());
    while (m.size > RELAY_DEDUPE_MAX_ENTRIES) m.delete(m.keys().next().value as string);
  }

  private takeToken(jobId: string): boolean {
    const now = this.now();
    let b = this.buckets.get(jobId);
    if (!b) this.buckets.set(jobId, (b = { tokens: RELAY_RATE_LIMIT_PER_WINDOW, updatedAt: now }));
    b.tokens = Math.min(
      RELAY_RATE_LIMIT_PER_WINDOW,
      b.tokens + ((now - b.updatedAt) * RELAY_RATE_LIMIT_PER_WINDOW) / RELAY_RATE_WINDOW_MS,
    );
    b.updatedAt = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    let w = this.windows.get(jobId);
    if (w && now - w.startedAt >= RELAY_RATE_WINDOW_MS) w = undefined;
    try {
      if (!w) {
        const runId = this.deps.recordRateLimited(jobId, RELAY_RATE_LIMITED_ERROR(1), undefined, now);
        this.windows.set(jobId, { startedAt: now, dropped: 1, runId });
      } else {
        w.dropped++;
        this.deps.recordRateLimited(jobId, RELAY_RATE_LIMITED_ERROR(w.dropped), w.runId, now);
      }
    } catch (err) {
      this.deps.logger.error('Failed to record rate-limited run', { jobId, error: String(err) });
    }
    this.deps.logger.warn('Relay event dropped: burst limit', { jobId });
    return false;
  }
}
