import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/daemon/store.js';
import { Scheduler } from '../src/daemon/scheduler.js';
import { Runner } from '../src/daemon/runner.js';
import { createApiServer } from '../src/daemon/api.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'crontick-fuzz-api-'));
}

async function postJson(port: number, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf-8')) });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: null });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

describe('fuzz: POST /api/jobs with random bodies', () => {
  let dir: string;
  let store: Store;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    dir = makeTmpDir();
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();

    const scheduler = new Scheduler();
    const runner = new Runner();
    server = createApiServer({
      store,
      scheduler,
      runner,
      startedAt: new Date(),
      port: 0,
      reload: async () => {},
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('random object bodies return 400 with structured error, never 500', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant('not an object'),
          fc.constant([]),
          fc.constant(42),
          fc.record({
            id: fc.oneof(fc.integer(), fc.string()),
            schedule: fc.oneof(
              fc.constant(null),
              fc.record({ kind: fc.constantFrom('invalid', 'cron', 'interval'), cron: fc.string() }),
            ),
            action: fc.oneof(fc.constant(null), fc.constant({})),
          }),
          fc.dictionary(fc.string({ maxLength: 20 }), fc.anything(), { maxKeys: 10 }),
        ),
        async (body) => {
          const { status, json } = await postJson(port, '/api/jobs', body ?? {});
          expect(status).not.toBe(500);
          if (status === 400) {
            expect(json).toBeTruthy();
            expect((json as Record<string, unknown>).error).toBeTruthy();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
