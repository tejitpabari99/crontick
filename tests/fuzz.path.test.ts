import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/daemon/store.js';
import { Scheduler } from '../src/daemon/scheduler.js';
import { Runner } from '../src/daemon/runner.js';
import { createApiServer } from '../src/daemon/api.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'crontick-fuzz-path-'));
}

async function getPath(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('fuzz: path traversal on dashboard route', () => {
  let dir: string;
  let store: Store;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    dir = makeTmpDir();
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    writeFileSync(join(dir, 'secret.txt'), 'secret-content', 'utf-8');

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

  it('path traversal attempts never return non-dashboard/error content', async () => {
    const traversalPaths = [
      '/dashboard/../../../etc/passwd',
      '/dashboard/../../package.json',
      '/dashboard/%2e%2e%2f%2e%2e%2fpackage.json',
      '/dashboard/..%2F..%2Fpackage.json',
      '/%2e%2e/secret.txt',
      '/dashboard/////../../../etc/hosts',
    ];

    for (const path of traversalPaths) {
      const { status, body } = await getPath(port, path);
      expect(body).not.toContain('secret-content');
      if (status === 200) {
        expect(body).not.toContain('secret-content');
      }
    }
  });

  it('property: random path segments with ../ never return secret content', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('..', '.', 'etc', 'passwd', 'secret', '../', '%2e%2e', '%2f'), {
          minLength: 1,
          maxLength: 6,
        }).map((parts) => '/dashboard/' + parts.join('/')),
        async (path) => {
          const { body } = await getPath(port, path);
          expect(body).not.toContain('secret-content');
        },
      ),
      { numRuns: 50 },
    );
  });
});
