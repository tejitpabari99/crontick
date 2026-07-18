import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/daemon/store.js';
import { Scheduler } from '../src/daemon/scheduler.js';
import { Runner } from '../src/daemon/runner.js';
import { createApiServer } from '../src/daemon/api.js';
import type { Job } from '../src/schemas/job.js';

const node = process.execPath;

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'crontick-sec-'));
}

async function request(opts: http.RequestOptions, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('Security', () => {
  let dir: string;
  let store: Store;
  let server: http.Server;

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
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('server binds only to 127.0.0.1 (loopback)', () => {
    const addr = server.address() as net.AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
  });

  it('non-loopback remoteAddress is rejected with 403', async () => {
    const dir2 = makeTmpDir();
    mkdirSync(join(dir2, 'jobs'), { recursive: true });
    const store2 = new Store(join(dir2, 'runs.db'), join(dir2, 'jobs'));
    store2.open();
    const srv2 = createApiServer({
      store: store2,
      scheduler: new Scheduler(),
      runner: new Runner(),
      startedAt: new Date(),
      port: 0,
      reload: async () => {},
    });

    await new Promise<void>((resolve) => srv2.listen(0, '127.0.0.1', resolve));
    const port2 = (srv2.address() as { port: number }).port;

    const patchRemote = (rawReq: http.IncomingMessage) => {
      Object.defineProperty(rawReq.socket, 'remoteAddress', {
        value: '192.168.1.1',
        configurable: true,
      });
    };
    srv2.prependListener('request', patchRemote);

    const { status } = await request({ host: '127.0.0.1', port: port2, path: '/health', method: 'GET' });
    expect(status).toBe(403);

    srv2.removeListener('request', patchRemote);
    await new Promise<void>((resolve) => srv2.close(() => resolve()));
    store2.close();
    rmSync(dir2, { recursive: true, force: true });
  });

  it('exec with shell=false does not expand shell metacharacters', async () => {
    const runner = new Runner();
    const store2Dir = makeTmpDir();
    mkdirSync(join(store2Dir, 'jobs'), { recursive: true });
    const store2 = new Store(join(store2Dir, 'runs.db'), join(store2Dir, 'jobs'));
    store2.open();

    const dangerousArg = '$(echo INJECTED)';
    const job: Job = {
      id: 'shell-inject',
      enabled: true,
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'exec', command: node, args: ['-e', 'process.stdout.write(process.argv[1])', dangerousArg] },
      catchup: 'skip',
      overlap: 'skip',
      retry: { max: 0, backoffSec: 30 },
      budgets: { maxRunsPerDay: null, maxTokensPerRun: null },
    };

    const run = store2.insertRun(job.id);
    await runner.run(job, run.id, store2);
    const output = store2.getLogs(run.id).map((log) => log.chunk.toString('utf-8')).join('');
    expect(output).toBe(dangerousArg);

    store2.close();
    rmSync(store2Dir, { recursive: true, force: true });
  }, 15_000);

  it('AWS-style access key in output is redacted in logs', async () => {
    const runner = new Runner();
    const logDir = makeTmpDir();
    mkdirSync(join(logDir, 'jobs'), { recursive: true });
    const logStore = new Store(join(logDir, 'runs.db'), join(logDir, 'jobs'));
    logStore.open();

    const secretValue = 'AKIA1234567890ABCDEF';
    const job: Job = {
      id: 'aws-secret',
      enabled: true,
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'exec', command: node, args: ['-e', `process.stdout.write('${secretValue}')`] },
      catchup: 'skip',
      overlap: 'skip',
      retry: { max: 0, backoffSec: 30 },
      budgets: { maxRunsPerDay: null, maxTokensPerRun: null },
    };

    const run = logStore.insertRun(job.id);
    await runner.run(job, run.id, logStore);
    const output = logStore.getLogs(run.id).map((log) => log.chunk.toString('utf-8')).join('');
    expect(output).not.toContain(secretValue);
    expect(output).toContain('[REDACTED]');

    logStore.close();
    rmSync(logDir, { recursive: true, force: true });
  }, 15_000);

  it('GitHub token in output is redacted in logs', async () => {
    const runner = new Runner();
    const logDir = makeTmpDir();
    mkdirSync(join(logDir, 'jobs'), { recursive: true });
    const logStore = new Store(join(logDir, 'runs.db'), join(logDir, 'jobs'));
    logStore.open();

    const ghToken = 'ghp_' + 'A'.repeat(36);
    const job: Job = {
      id: 'gh-token',
      enabled: true,
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'exec', command: node, args: ['-e', `process.stdout.write('${ghToken}')`] },
      catchup: 'skip',
      overlap: 'skip',
      retry: { max: 0, backoffSec: 30 },
      budgets: { maxRunsPerDay: null, maxTokensPerRun: null },
    };

    const run = logStore.insertRun(job.id);
    await runner.run(job, run.id, logStore);
    const output = logStore.getLogs(run.id).map((log) => log.chunk.toString('utf-8')).join('');
    expect(output).not.toContain(ghToken);
    expect(output).toContain('[REDACTED]');

    logStore.close();
    rmSync(logDir, { recursive: true, force: true });
  }, 15_000);

  it('loadJobsFromDisk with symlinked file outside jobsDir does not crash', () => {
    const outsideDir = makeTmpDir();
    const secretJobPath = join(outsideDir, 'secret-job.json');
    const secretJob = {
      id: 'secret-job',
      enabled: true,
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'exec', command: 'echo', args: [] },
      catchup: 'skip',
      overlap: 'skip',
      retry: { max: 0, backoffSec: 30 },
      budgets: { maxRunsPerDay: null, maxTokensPerRun: null },
    };
    writeFileSync(secretJobPath, JSON.stringify(secretJob), 'utf-8');

    const symlinkPath = join(dir, 'jobs', 'secret-job.json');
    try {
      symlinkSync(secretJobPath, symlinkPath);
    } catch {
      rmSync(outsideDir, { recursive: true, force: true });
      return;
    }

    expect(() => store.loadJobsFromDisk()).not.toThrow();
    rmSync(outsideDir, { recursive: true, force: true });
  });
});
