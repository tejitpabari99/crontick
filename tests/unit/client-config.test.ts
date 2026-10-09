import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClient } from '../../src/client.js';
import { CONFIG_EDIT_NOTICE } from '../../src/constants/config.js';
import { stopDaemon } from '../../src/daemon/lifecycle.js';
import { writeFakeEngineConfig } from '../helpers/fake-engine.js';
import { writeTestConfig } from '../helpers/test-home.js';
import * as publicApi from '../../src/index.js';

const DAEMON_SCRIPT = join(process.cwd(), 'dist', 'daemon', 'index.js');
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function makeHome(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'crontick-clientcfg-'));
  const env = { ...process.env, CRONTICK_HOME: dir };
  cleanups.push(async () => {
    await stopDaemon({ env }).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, env };
}

describe('client config methods (daemon down)', () => {
  it('configSet writes, reports daemon-not-running and never spawns a daemon', async () => {
    const { dir, env } = makeHome();
    const client = createClient({ env });
    const res = await client.configSet('defaults.timeoutSec', 600);
    expect(res.reload).toBe('daemon-not-running');
    expect(res.changed).toEqual(['defaults.timeoutSec']);
    expect(res.notice).toBe(CONFIG_EDIT_NOTICE);
    expect(res.warnings).toEqual([]);
    expect(res.config.defaults.timeoutSec).toBe(600);
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'))).toEqual({ defaults: { timeoutSec: 600 } });
    expect(existsSync(join(dir, 'daemon.pid'))).toBe(false);
    expect(existsSync(join(dir, 'daemon.port'))).toBe(false);
  });

  it('configList / configGet / configUnset round trip with redaction', async () => {
    const { env } = makeHome();
    const client = createClient({ env, startDaemon: false });
    const secret = `sk-proj-${'R'.repeat(28)}`;
    await client.configSet('engines.agency', { command: 'agency', env: { OPENAI_API_KEY: secret } });
    const list = client.configList();
    expect(list.config.engines['agency']?.env['OPENAI_API_KEY']).toBe('[REDACTED]');
    expect(JSON.stringify(list)).not.toContain(secret);
    expect(list.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(client.configGet('engines.agency.command')).toBe('agency');
    expect(client.configGet('engines.agency.env.OPENAI_API_KEY')).toBe('[REDACTED]');
    const un = await client.configUnset('engines.agency');
    expect(un.changed).toEqual(['engines.agency']);
    expect(un.config.engines).not.toHaveProperty('agency');
  });

  it('removed superseded exports; kept getConfig and configPath', () => {
    const client = createClient({ startDaemon: false }) as unknown as Record<string, unknown>;
    for (const m of ['getConfigValue', 'setConfigValue', 'removeConfigValue', 'listEngines', 'addEngine', 'updateEngine', 'removeEngine']) {
      expect(client[m], m).toBeUndefined();
      expect((publicApi as Record<string, unknown>)[m], `index ${m}`).toBeUndefined();
    }
    expect(typeof client['getConfig']).toBe('function');
    expect(typeof client['configPath']).toBe('function');
  });
});

describe('client config methods (daemon up)', () => {
  it('reports reloaded and warns when removing an engine used by a job', async () => {
    const { dir, env } = makeHome();
    writeFakeEngineConfig(dir);
    const client = createClient({ env, daemonScript: DAEMON_SCRIPT, startupTimeoutMs: 15_000 });
    await client.ensure();
    await client.createJob({
      alias: 'fake-job',
      schedule: { kind: 'interval', everySec: 3600 },
      action: { kind: 'prompt', prompt: '1', engine: 'node-fake' },
    });

    const ok = await client.configSet('defaults.timeoutSec', 300);
    expect(ok.reload).toBe('reloaded');
    expect(ok.warnings).toEqual([]);

    const removed = await client.configUnset('engines.node-fake');
    expect(removed.reload).toBe('reloaded');
    expect(removed.changed).toEqual(['engines.node-fake']);
    expect(removed.warnings.join('\n')).toMatch(/node-fake/);
    expect(removed.warnings.join('\n')).toContain('fake-job');
    expect(removed.config.engines).not.toHaveProperty('node-fake');
  }, 60_000);

  it('a failed reload still saves: reload failed + warning', async () => {
    const { dir, env } = makeHome();
    writeTestConfig(dir);
    const client = createClient({ env, daemonScript: DAEMON_SCRIPT, startupTimeoutMs: 15_000 });
    await client.ensure();
    // Corrupt reachability: point the client at a dead URL while pid/port files still say up.
    writeFileSync(join(dir, 'daemon.port'), '1');
    const fresh = createClient({ env, startDaemon: false });
    const res = await fresh.configSet('defaults.timeoutSec', 123);
    expect(res.reload).toBe('failed');
    expect(res.warnings.join('\n')).toContain('crontick daemon reload');
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')).defaults.timeoutSec).toBe(123);
  }, 60_000);
});
