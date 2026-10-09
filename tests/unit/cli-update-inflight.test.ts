import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI = resolve('dist', 'cli', 'index.js');
const job = {
  id: '11111111-1111-4111-8111-111111111111',
  alias: 'busy',
  enabled: true,
  schedule: { kind: 'interval', everySec: 3600 },
  action: { kind: 'prompt', prompt: 'p', args: [], reuseSession: false },
  overlap: 'skip',
  retry: { max: 0, backoffSec: 30 },
};

describe('crontick jobs update --stop-running / --wait-running', () => {
  let server: http.Server;
  let baseUrl: string;
  const puts: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && (req.url ?? '').startsWith('/health')) {
        return void res.end(JSON.stringify({ ok: true, product: 'crontick', pid: process.pid, port: (server.address() as AddressInfo).port }));
      }
      if (req.method === 'GET') return void res.end(JSON.stringify(job));
      puts.push(req.url ?? '');
      if (!(req.url ?? '').includes('inFlight=')) {
        res.statusCode = 409;
        return void res.end(JSON.stringify({ error: { code: 'RUNS_IN_FLIGHT', message: 'Runs are in flight: busy (run r1).', details: { runs: [{ runId: 'r1', jobId: '11111111-1111-4111-8111-111111111111' }] } } }));
      }
      res.end(JSON.stringify(job));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });

  function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((done) => {
      const child = execFile(process.execPath, [CLI, ...args], { env: { ...process.env, CRONTICK_DAEMON_URL: baseUrl }, encoding: 'utf8' }, (err, stdout, stderr) => {
        done({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout, stderr });
      });
      child.stdin?.end();
    });
  }

  it('lists both flags in help', async () => {
    const r = await cli(['jobs', 'update', '--help']);
    expect(r.stdout).toContain('--stop-running');
    expect(r.stdout).toContain('--wait-running');
  });

  it('without a choice on a non-TTY: fails with flag guidance', async () => {
    puts.length = 0;
    const r = await cli(['jobs', 'update', 'busy', '--desc', 'x']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('RUNS_IN_FLIGHT');
    expect(r.stderr).toContain('--stop-running');
    expect(r.stderr).toContain('--wait-running');
  });

  it('--stop-running and --wait-running send the choice up front', async () => {
    puts.length = 0;
    const stop = await cli(['jobs', 'update', 'busy', '--desc', 'x', '--stop-running']);
    expect(stop.code, stop.stderr).toBe(0);
    const wait = await cli(['jobs', 'update', 'busy', '--desc', 'x', '--wait-running']);
    expect(wait.code, wait.stderr).toBe(0);
    expect(puts).toEqual(['/api/jobs/busy?inFlight=stop', '/api/jobs/busy?inFlight=wait']);
  });

  it('both flags together is a validation error and sends nothing', async () => {
    puts.length = 0;
    const r = await cli(['jobs', 'update', 'busy', '--desc', 'x', '--stop-running', '--wait-running']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--stop-running');
    expect(puts).toEqual([]);
  });
});
