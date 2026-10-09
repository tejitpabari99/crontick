/**
 * In-process daemon API harness: real Store + Scheduler + HTTP API server on an
 * ephemeral loopback port, backed by an isolated scratch CRONTICK_HOME. Runner
 * is a stub unless supplied.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { createApiServer } from '../../src/daemon/api.js';
import type { Runner } from '../../src/daemon/runner.js';
import { Scheduler } from '../../src/daemon/scheduler.js';
import { Store } from '../../src/daemon/store.js';

/** Parsed JSON response body; loosely typed on purpose for test assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ApiResponseBody = any;

export interface ApiHarness {
  dir: string;
  store: Store;
  port: number;
  baseUrl: string;
  call(method: string, path: string, body?: unknown): Promise<{ status: number; data: ApiResponseBody }>;
  close(): Promise<void>;
}

export async function startApiHarness(scratchName: string, runner?: Partial<Runner>): Promise<ApiHarness> {
  const dir = resolve('.crontick', scratchName, randomUUID());
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const previousHome = process.env['CRONTICK_HOME'];
  process.env['CRONTICK_HOME'] = dir;
  const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
  store.open();
  const ctx = {
    store,
    scheduler: new Scheduler(),
    runner: { run: async () => {}, cancelJob: () => false, cancelRun: () => false, listInFlight: () => [], cancelAllInFlight: async () => {}, waitForIdle: async () => {}, ...runner } as unknown as Runner,
    startedAt: new Date(),
    port: 0,
    reload: async () => {},
  };
  const server = createApiServer(ctx);
  await new Promise<void>((res, rej) => {
    server.listen(0, '127.0.0.1', () => res());
    server.on('error', rej);
  });
  const port = (server.address() as AddressInfo).port;
  ctx.port = port;
  return {
    dir,
    store,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async call(method, path, body) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let data: ApiResponseBody;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data };
    },
    async close() {
      await new Promise<void>((res) => server.close(() => res()));
      store.close();
      if (previousHome === undefined) delete process.env['CRONTICK_HOME'];
      else process.env['CRONTICK_HOME'] = previousHome;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function sampleJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: 'sample',
    enabled: true,
    schedule: { kind: 'interval', everySec: 3600 },
    action: { kind: 'prompt', prompt: 'noop', args: [], reuseSession: false },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
    ...overrides,
  };
}
