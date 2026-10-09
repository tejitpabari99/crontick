import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApiHarness, type ApiHarness } from '../helpers/api-harness.js';

describe('GET/PATCH /api/config', () => {
  let h: ApiHarness;
  const cfgPath = () => join(h.dir, 'config.json');
  beforeAll(async () => { h = await startApiHarness('api-config'); });
  afterAll(async () => { await h.close(); });

  it('GET returns path, revision, config, stored, readOnly, notice', async () => {
    const r = await h.call('GET', '/api/config');
    expect(r.status).toBe(200);
    expect(r.data.path).toBe(cfgPath());
    expect(typeof r.data.revision).toBe('string');
    expect(r.data.config.retention).toBeDefined();
    expect(r.data.stored).toBeDefined();
    expect(r.data.readOnly).toEqual(['daemon']);
    expect(r.data.notice).toMatch(/Saved/);
  });

  it('PATCH applies a multi-op batch atomically and returns the apply result', async () => {
    const r = await h.call('PATCH', '/api/config', {
      ops: [
        { op: 'set', key: 'retention.maxRunsPerJob', value: 77 },
        { op: 'set', key: 'maxConsecutiveFailures', value: 4 },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.data.changed).toEqual(['retention.maxRunsPerJob', 'maxConsecutiveFailures']);
    expect(r.data.config.retention.maxRunsPerJob).toBe(77);
    expect(r.data.inFlightPolicy).toBe('none');
    const onDisk = JSON.parse(readFileSync(cfgPath(), 'utf-8'));
    expect(onDisk.retention.maxRunsPerJob).toBe(77);
    expect(onDisk.maxConsecutiveFailures).toBe(4);
    expect((await h.call('GET', '/api/config')).data.revision).toBe(r.data.revision);
  });

  it('invalid op in batch writes nothing', async () => {
    const before = readFileSync(cfgPath(), 'utf-8');
    const r = await h.call('PATCH', '/api/config', {
      ops: [
        { op: 'set', key: 'maxConsecutiveFailures', value: 9 },
        { op: 'set', key: 'retention.maxRunsPerJob', value: 0 },
      ],
    });
    expect(r.status).toBe(400);
    expect(readFileSync(cfgPath(), 'utf-8')).toBe(before);
  });

  it('rejects malformed bodies with 400', async () => {
    for (const body of [{}, { ops: 'x' }, { ops: [{ op: 'nope', key: 'a' }] }, { ops: [{ op: 'set' }] }, { ops: [], inFlight: 'bogus' }]) {
      const r = await h.call('PATCH', '/api/config', body);
      expect(r.status).toBe(400);
    }
  });

  it('stale ifRevision gives 409 CONFIG_CONFLICT and writes nothing', async () => {
    const before = readFileSync(cfgPath(), 'utf-8');
    const r = await h.call('PATCH', '/api/config', { ifRevision: 'stale', ops: [{ op: 'set', key: 'maxConsecutiveFailures', value: 1 }] });
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('CONFIG_CONFLICT');
    expect(readFileSync(cfgPath(), 'utf-8')).toBe(before);
  });

  it('matching ifRevision succeeds', async () => {
    const rev = (await h.call('GET', '/api/config')).data.revision;
    const r = await h.call('PATCH', '/api/config', { ifRevision: rev, ops: [{ op: 'set', key: 'maxConsecutiveFailures', value: 5 }] });
    expect(r.status).toBe(200);
  });

  it('daemon.* ops are always read-only', async () => {
    const before = readFileSync(cfgPath(), 'utf-8');
    for (const op of [{ op: 'set', key: 'daemon.port', value: 4000 }, { op: 'unset', key: 'daemon' }]) {
      const r = await h.call('PATCH', '/api/config', { ops: [op] });
      expect(r.status).toBe(400);
      expect(r.data.error.code).toBe('CONFIG_KEY_READ_ONLY');
    }
    expect(readFileSync(cfgPath(), 'utf-8')).toBe(before);
  });

  it('secrets are redacted on read and restored when echoed back', async () => {
    writeFileSync(cfgPath(), JSON.stringify({ engines: { x: { command: 'echo', args: [], env: { API_KEY: 'sekret-value-123' } } } }, null, 2));
    const got = await h.call('GET', '/api/config');
    expect(JSON.stringify(got.data)).not.toContain('sekret-value-123');
    const echoed = got.data.stored.engines.x.env.API_KEY;
    expect(echoed).toContain('[REDACTED]');
    const r = await h.call('PATCH', '/api/config', { ifRevision: got.data.revision, ops: [{ op: 'set', key: 'engines.x', value: got.data.stored.engines.x }] });
    expect(r.status).toBe(200);
    expect(JSON.parse(readFileSync(cfgPath(), 'utf-8')).engines.x.env.API_KEY).toBe('sekret-value-123');
    const bad = await h.call('PATCH', '/api/config', { ops: [{ op: 'set', key: 'engines.x.env.API_KEY', value: 'a [REDACTED] b' }] });
    expect(bad.data.error.code).toBe('CONFIG_REDACTED_VALUE');
  });
});

describe('PATCH /api/config with runs in flight', () => {
  it('409 RUNS_IN_FLIGHT without a choice; invalid/stale batches cancel nothing', async () => {
    let canceled = 0;
    const h = await startApiHarness('api-config-inflight', {
      listInFlight: () => [{ runId: 'r1', jobId: 'j1' }] as never,
      cancelAllInFlight: async () => { canceled++; },
    });
    try {
      const ops = [{ op: 'set', key: 'maxConsecutiveFailures', value: 3 }];
      const none = await h.call('PATCH', '/api/config', { ops });
      expect(none.status).toBe(409);
      expect(none.data.error.code).toBe('RUNS_IN_FLIGHT');
      const stale = await h.call('PATCH', '/api/config', { ops, inFlight: 'stop', ifRevision: 'stale' });
      expect(stale.status).toBe(409);
      expect(stale.data.error.code).toBe('CONFIG_CONFLICT');
      const bad = await h.call('PATCH', '/api/config', { ops: [{ op: 'set', key: 'retention.maxRunsPerJob', value: 0 }], inFlight: 'stop' });
      expect(bad.status).toBe(400);
      expect(canceled).toBe(0);
      const ok = await h.call('PATCH', '/api/config', { ops, inFlight: 'stop' });
      expect(ok.status).toBe(200);
      expect(ok.data.inFlightPolicy).toBe('stop');
      expect(canceled).toBe(1);
    } finally {
      await h.close();
    }
  });
});
