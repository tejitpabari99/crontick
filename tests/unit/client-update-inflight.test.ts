import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '../../src/client.js';

const job = {
  id: '11111111-1111-4111-8111-111111111111',
  alias: 'busy',
  enabled: true,
  schedule: { kind: 'interval', everySec: 3600 },
  action: { kind: 'prompt', prompt: 'p', args: [], reuseSession: false },
  overlap: 'skip',
  retry: { max: 0, backoffSec: 30 },
};

describe('client.updateJob inFlight option', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });
  async function serve(onPut: (url: string, res: http.ServerResponse) => void): Promise<{ urls: string[]; client: ReturnType<typeof createClient> }> {
    const urls: string[] = [];
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && (req.url ?? '').startsWith('/health')) {
        return void res.end(JSON.stringify({ ok: true, product: 'crontick', pid: process.pid, port: (server.address() as AddressInfo).port }));
      }
      if (req.method === 'GET') return void res.end(JSON.stringify(job));
      urls.push(req.url ?? '');
      onPut(req.url ?? '', res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const client = createClient({ daemonUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, startDaemon: false, requestTimeoutMs: 150 });
    return { urls, client };
  }

  it('sends inFlight as a query param on the PUT', async () => {
    const { urls, client } = await serve((_u, res) => res.end(JSON.stringify(job)));
    await client.updateJob('busy', { description: 'x' }, { inFlight: 'stop' });
    await client.updateJob('busy', { description: 'x' }, { inFlight: 'wait' });
    await client.updateJob('busy', { description: 'x' });
    expect(urls).toEqual(['/api/jobs/busy?inFlight=stop', '/api/jobs/busy?inFlight=wait', '/api/jobs/busy']);
  });

  it('surfaces RUNS_IN_FLIGHT with the run list', async () => {
    const { client } = await serve((_u, res) => {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: { code: 'RUNS_IN_FLIGHT', message: 'Runs are in flight', details: { runs: [{ runId: 'r1', jobId: '11111111-1111-4111-8111-111111111111' }] } } }));
    });
    await expect(client.updateJob('busy', { description: 'x' })).rejects.toMatchObject({
      code: 'RUNS_IN_FLIGHT',
      details: { runs: [{ runId: 'r1', jobId: '11111111-1111-4111-8111-111111111111' }] },
    });
  });

  it('wait mode is not subject to the request timeout', async () => {
    const { client } = await serve((_u, res) => { setTimeout(() => res.end(JSON.stringify(job)), 400); });
    await expect(client.updateJob('busy', { description: 'x' }, { inFlight: 'wait' })).resolves.toMatchObject({ id: '11111111-1111-4111-8111-111111111111' });
  });

  it('rejects an invalid choice before any request', async () => {
    const { urls, client } = await serve((_u, res) => res.end('{}'));
    await expect(client.updateJob('busy', {}, { inFlight: 'later' as never })).rejects.toMatchObject({ code: 'INVALID_IN_FLIGHT_CHOICE' });
    expect(urls).toEqual([]);
  });
});
