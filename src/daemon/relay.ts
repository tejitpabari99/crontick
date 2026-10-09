/**
 * Relay manager: one outbound SSE connection per distinct relay URL, refcounted by
 * subscribing job ids (SP06 D1/D4/D8). `message` events become `webhook` triggers via
 * the SP05 dispatcher, which re-checks job existence, kind and enabled at event time.
 * Status is in memory only. No replay, no Last-Event-ID.
 */
import type { Logger } from '../logger.js';
import { redactSmeeUrlsInText } from '../utils/webhook-redact.js';
import type { Job } from '../schemas/job.js';
import {
  RELAY_BACKOFF_BASE_MS,
  RELAY_BACKOFF_MAX_MS,
  RELAY_IDLE_TIMEOUT_MS,
  RELAY_STABLE_MS,
} from '../constants/relay.js';
import { buildWebhookContext, buildWebhookPayload, flattenRelayHeaders } from '../utils/webhook-payload.js';
import { connectSse, type SseEvent } from './sse.js';
import type { TriggerRequest, TriggerResult } from './trigger.js';

export type RelayState = 'connecting' | 'connected' | 'backoff' | 'error';

export interface RelayStatus {
  /** Normalized relay URL (a bearer secret: callers must redact before display). */
  url: string;
  state: RelayState;
  jobIds: string[];
  lastEventAt: string | null;
  lastError: string | null;
  eventCount: number;
}

/** A parsed relay delivery handed to the (Task 5) verify/dedupe/rate-limit seam. */
export interface RelayDelivery {
  jobId: string;
  relayUrl: string;
  /** Parsed smee event data (headers are top-level keys, plus `body`, `query`). */
  data: Record<string, unknown>;
  sseId: string | undefined;
}

export interface RelayManagerDeps {
  dispatcher: { dispatch(jobId: string, req: TriggerRequest): TriggerResult };
  logger: Logger;
  fetch?: typeof fetch;
  /** Returns [0,1); injectable for deterministic jitter. */
  random?: () => number;
  now?: () => number;
  /**
   * Seam for HMAC / dedupe / burst guards (Task 5). Return false to drop the delivery.
   * May rewrite nothing; runs per subscribed job before dispatch.
   */
  guard?: (delivery: RelayDelivery) => boolean;
  /** True when the job verifies an HMAC secret: only the signed `body` is then delivered (no headers/query). */
  bodyOnly?: (jobId: string) => boolean;
}

interface Conn {
  url: string;
  jobs: Set<string>;
  state: RelayState;
  lastEventAt: number | null;
  lastError: string | null;
  eventCount: number;
  stopped: boolean;
  abort: AbortController | null;
  wake: (() => void) | null;
}


function normalizeUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

export class RelayManager {
  private readonly conns = new Map<string, Conn>();
  private readonly jobUrl = new Map<string, string>();
  private stopped = false;
  private readonly logger: Logger;
  private readonly fetchFn: typeof fetch;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(private readonly deps: RelayManagerDeps) {
    this.logger = deps.logger;
    this.fetchFn = deps.fetch ?? ((input, init) => fetch(input, init));
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
  }

  subscribe(jobId: string, url: string): void {
    if (this.stopped) return;
    const norm = normalizeUrl(url);
    const current = this.jobUrl.get(jobId);
    if (current === norm) return;
    if (current !== undefined) this.unsubscribe(jobId);
    let conn = this.conns.get(norm);
    if (!conn) {
      conn = {
        url: norm, jobs: new Set(), state: 'connecting', lastEventAt: null, lastError: null,
        eventCount: 0, stopped: false, abort: null, wake: null,
      };
      this.conns.set(norm, conn);
      conn.jobs.add(jobId);
      this.jobUrl.set(jobId, norm);
      void this.loop(conn);
      return;
    }
    conn.jobs.add(jobId);
    this.jobUrl.set(jobId, norm);
  }

  unsubscribe(jobId: string): void {
    const url = this.jobUrl.get(jobId);
    if (url === undefined) return;
    this.jobUrl.delete(jobId);
    const conn = this.conns.get(url);
    if (!conn) return;
    conn.jobs.delete(jobId);
    if (conn.jobs.size === 0) {
      this.conns.delete(url);
      this.halt(conn);
    }
  }

  /** Idempotent: diff enabled webhook jobs with a relay against current subscriptions. */
  sync(jobs: readonly Job[]): void {
    if (this.stopped) return;
    const desired = new Map<string, string>();
    for (const job of jobs) {
      if (job.enabled && job.schedule.kind === 'webhook' && job.schedule.relay) {
        desired.set(job.id, normalizeUrl(job.schedule.relay));
      }
    }
    for (const [jobId, url] of [...this.jobUrl]) {
      if (desired.get(jobId) !== url) this.unsubscribe(jobId);
    }
    for (const [jobId, url] of desired) this.subscribe(jobId, url);
  }

  status(): RelayStatus[] {
    return [...this.conns.values()].map((c) => ({
      url: c.url,
      state: c.state,
      jobIds: [...c.jobs],
      lastEventAt: c.lastEventAt === null ? null : new Date(c.lastEventAt).toISOString(),
      lastError: c.lastError,
      eventCount: c.eventCount,
    }));
  }

  stop(): void {
    this.stopped = true;
    for (const conn of this.conns.values()) this.halt(conn);
    this.conns.clear();
    this.jobUrl.clear();
  }

  private halt(conn: Conn): void {
    conn.stopped = true;
    conn.abort?.abort();
    conn.wake?.();
  }

  private async loop(conn: Conn): Promise<void> {
    let attempt = 0;
    while (!conn.stopped) {
      const ac = new AbortController();
      conn.abort = ac;
      conn.state = 'connecting';
      let connectedAt: number | null = null;
      let idle: ReturnType<typeof setTimeout> | undefined;
      let idled = false;
      const arm = (): void => {
        clearTimeout(idle);
        idle = setTimeout(() => { idled = true; ac.abort(); }, RELAY_IDLE_TIMEOUT_MS);
      };
      arm();
      try {
        await connectSse(conn.url, {
          fetch: this.fetchFn,
          signal: ac.signal,
          onActivity: () => {
            if (conn.stopped) return;
            if (connectedAt === null) {
              connectedAt = this.now();
              conn.state = 'connected';
              conn.lastError = null;
            }
            arm();
          },
          onEvent: (e) => this.onEvent(conn, e),
        });
        // A stream that ended after it had connected is a normal reconnect, not an error to surface.
        if (!conn.stopped) conn.lastError = connectedAt === null ? 'stream ended' : null;
      } catch (err) {
        if (conn.stopped) break;
        conn.lastError = idled ? `idle timeout (${RELAY_IDLE_TIMEOUT_MS}ms without data)` : (err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(idle);
      }
      if (conn.stopped) break;
      if (connectedAt !== null && this.now() - connectedAt >= RELAY_STABLE_MS) attempt = 0;
      const cap = Math.min(RELAY_BACKOFF_MAX_MS, RELAY_BACKOFF_BASE_MS * 2 ** attempt);
      attempt++;
      conn.state = 'backoff';
      this.logger.debug('Relay disconnected; backing off', { attempt, error: conn.lastError === null ? null : redactSmeeUrlsInText(conn.lastError) });
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { conn.wake = null; resolve(); }, this.random() * cap);
        conn.wake = () => { clearTimeout(t); conn.wake = null; resolve(); };
      });
    }
  }

  private onEvent(conn: Conn, e: SseEvent): void {
    if (conn.stopped || this.stopped) return;
    if (e.event !== 'message') return; // ready / ping / unknown
    let data: unknown;
    try {
      data = JSON.parse(e.data);
    } catch {
      this.logger.debug('Relay event dropped: invalid JSON');
      return;
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      this.logger.debug('Relay event dropped: not a JSON object');
      return;
    }
    const obj = data as Record<string, unknown>;
    conn.eventCount++;
    conn.lastEventAt = this.now();

    const headers = flattenRelayHeaders(obj);
    const receivedAt = new Date(this.now()).toISOString();
    const contexts = new Map<boolean, ReturnType<typeof buildWebhookContext>>();
    // Signed jobs get only the HMAC-covered body (headers/query are unauthenticated); others get everything.
    const contextFor = (bodyOnly: boolean): ReturnType<typeof buildWebhookContext> => {
      let c = contexts.get(bodyOnly);
      if (!c) {
        const payload = buildWebhookPayload({
          headers,
          body: obj['body'],
          ...(obj['query'] !== undefined ? { query: obj['query'] } : {}),
          receivedAt,
          verified: bodyOnly,
        });
        contexts.set(bodyOnly, (c = buildWebhookContext({ payload, source: 'relay' })));
      }
      return c;
    };

    for (const jobId of [...conn.jobs]) {
      if (conn.stopped || !conn.jobs.has(jobId)) continue;
      try {
        if (this.deps.guard && !this.deps.guard({ jobId, relayUrl: conn.url, data: obj, sseId: e.id })) continue;
        const ctx = contextFor(this.deps.bodyOnly?.(jobId) === true);
        const res = this.deps.dispatcher.dispatch(jobId, {
          kind: 'webhook', env: ctx.env, meta: { ...ctx.meta }, promptSuffix: ctx.promptSuffix,
        });
        this.logger.debug('Relay event dispatched', { jobId, result: res });
      } catch (err) {
        this.logger.error('Relay dispatch failed', { jobId, error: String(err) });
      }
    }
  }
}
