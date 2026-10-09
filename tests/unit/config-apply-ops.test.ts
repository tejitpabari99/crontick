import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { applyOps, getConfigRevision, redactStoredConfigForRead } from '../../src/config.js';
import { CONFIG_EDIT_NOTICE, CONFIG_REDACTED_MARKER } from '../../src/constants/config.js';
import { CrontickError } from '../../src/errors.js';
import { redactValue } from '../../src/logger.js';

const scratchRoot = resolve('.crontick', 'config-apply-ops-tests');
const cleanupDirs: string[] = [];

function makeHome(): { env: NodeJS.ProcessEnv; path: string } {
  const home = join(scratchRoot, randomUUID());
  mkdirSync(home, { recursive: true });
  cleanupDirs.push(home);
  return { env: { ...process.env, CRONTICK_HOME: home }, path: join(home, 'config.json') };
}
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const noDaemon = () => false;
const up = () => true;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return (e as CrontickError).code; }
  return 'NO_ERROR';
}

describe('applyOps core', () => {
  it('exports notice and marker constants', () => {
    expect(CONFIG_EDIT_NOTICE).toContain('Running runs are not affected');
    expect(CONFIG_EDIT_NOTICE).toContain('daemon.port');
    expect(CONFIG_REDACTED_MARKER).toBe(redactValue('x', 'apiKey'));
  });

  it('writes sparse files: only the set key, creating the file', async () => {
    const { env, path } = makeHome();
    const res = await applyOps([{ op: 'set', key: 'defaults.timeoutSec', value: 600 }], { env, daemonRunning: noDaemon });
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ defaults: { timeoutSec: 600 } });
    expect(res.changed).toEqual(['defaults.timeoutSec']);
    expect(res.config.defaults.timeoutSec).toBe(600);
    expect(res.revision).toBe(sha(readFileSync(path)));
    expect(res.path).toBe(path);
  });

  it('unset removes the key and leaves the file sparse', async () => {
    const { env, path } = makeHome();
    writeFileSync(path, JSON.stringify({ defaults: { timeoutSec: 600 }, maxConsecutiveFailures: 3 }));
    await applyOps([{ op: 'unset', key: 'defaults.timeoutSec' }], { env, daemonRunning: noDaemon });
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ defaults: {}, maxConsecutiveFailures: 3 });
  });

  it('batches several ops in one write', async () => {
    const { env, path } = makeHome();
    await applyOps(
      [{ op: 'set', key: 'retention.maxRunsPerJob', value: 5 }, { op: 'set', key: 'maxConsecutiveFailures', value: 2 }],
      { env, daemonRunning: noDaemon },
    );
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ retention: { maxRunsPerJob: 5 }, maxConsecutiveFailures: 2 });
  });

  it.each([
    [{ op: 'set', key: 'retention.maxRunsPerJob', value: 0 }],
    [{ op: 'set', key: 'bogus.key', value: 1 }],
    [{ op: 'set', key: 'defaults.timeoutSec', value: 'abc' }],
    [{ op: 'set', key: 'defaultEngine', value: 'nope' }],
    [{ op: 'unset', key: 'defaultEngine.x' }],
  ] as const)('invalid op %j fails and leaves file byte-identical', async (op) => {
    const { env, path } = makeHome();
    writeFileSync(path, '{"maxConsecutiveFailures":4}\n');
    const before = readFileSync(path);
    await expect(applyOps([{ op: 'set', key: 'maxConsecutiveFailures', value: 9 }, op as never], { env, daemonRunning: noDaemon })).rejects.toBeInstanceOf(CrontickError);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('invalid op on absent file creates no file', async () => {
    const { env, path } = makeHome();
    await expect(applyOps([{ op: 'set', key: 'retention.maxRunsPerJob', value: 0 }], { env, daemonRunning: noDaemon })).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('error names key and file, with hand-edit guidance (no config init)', async () => {
    const { env, path } = makeHome();
    try {
      await applyOps([{ op: 'set', key: 'retention.maxRunsPerJob', value: 0 }], { env, daemonRunning: noDaemon });
      throw new Error('should fail');
    } catch (e) {
      const err = e as CrontickError;
      expect(err.code).toBe('CONFIG_VALIDATION_ERROR');
      expect(err.message).toContain('retention.maxRunsPerJob');
      expect(err.message).toContain(path);
      expect(err.message).not.toContain('config init');
    }
  });

  it('refuses on an already-invalid or unparsable file, unchanged', async () => {
    const { env, path } = makeHome();
    for (const content of ['{"retention":{"nope":1}}', '{not json']) {
      writeFileSync(path, content);
      const err = await codeOf(applyOps([{ op: 'set', key: 'maxConsecutiveFailures', value: 2 }], { env, daemonRunning: noDaemon }));
      expect(['CONFIG_VALIDATION_ERROR', 'CONFIG_READ_ERROR']).toContain(err);
      expect(readFileSync(path, 'utf-8')).toBe(content);
    }
    writeFileSync(path, '{not json');
    await expect(applyOps([{ op: 'set', key: 'maxConsecutiveFailures', value: 2 }], { env, daemonRunning: noDaemon })).rejects.toThrow(/Edit .*config\.json|hand/i);
  });

  it('unset of a missing key is CONFIG_KEY_NOT_FOUND', async () => {
    const { env } = makeHome();
    expect(await codeOf(applyOps([{ op: 'unset', key: 'defaults.timeoutSec' }], { env, daemonRunning: noDaemon }))).toBe('CONFIG_KEY_NOT_FOUND');
  });

  it('engine add and remove; default engine removal rejected', async () => {
    const { env, path } = makeHome();
    await applyOps([{ op: 'set', key: 'engines.x', value: { command: 'echo', type: 'raw' } }], { env, daemonRunning: noDaemon });
    expect(JSON.parse(readFileSync(path, 'utf-8')).engines.x).toEqual({ command: 'echo', type: 'raw' });
    await applyOps([{ op: 'unset', key: 'engines.x' }], { env, daemonRunning: noDaemon });
    expect(JSON.parse(readFileSync(path, 'utf-8')).engines).toEqual({});
    expect(await codeOf(applyOps([{ op: 'unset', key: 'engines.claude' }], { env, daemonRunning: noDaemon }))).toBe('CONFIG_KEY_NOT_FOUND');
  });
});

describe('revision / ifRevision', () => {
  it('getConfigRevision is absent for missing file, sha256 otherwise', async () => {
    const { env, path } = makeHome();
    expect(getConfigRevision({ env })).toBe('absent');
    writeFileSync(path, '{}\n');
    expect(getConfigRevision({ env })).toBe(sha('{}\n'));
  });

  it('matching ifRevision succeeds; stale yields CONFIG_CONFLICT with file unchanged', async () => {
    const { env, path } = makeHome();
    expect(await codeOf(applyOps([{ op: 'set', key: 'maxConsecutiveFailures', value: 2 }], { env, daemonRunning: noDaemon, ifRevision: 'absent' }))).toBe('NO_ERROR');
    const rev = getConfigRevision({ env });
    writeFileSync(path, '{"maxConsecutiveFailures":7}\n');
    const before = readFileSync(path);
    expect(await codeOf(applyOps([{ op: 'set', key: 'maxConsecutiveFailures', value: 3 }], { env, daemonRunning: noDaemon, ifRevision: rev }))).toBe('CONFIG_CONFLICT');
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(await codeOf(applyOps([{ op: 'set', key: 'maxConsecutiveFailures', value: 3 }], { env, daemonRunning: noDaemon, ifRevision: 'absent' }))).toBe('CONFIG_CONFLICT');
  });
});

describe('file mode', () => {
  it.skipIf(process.platform === 'win32')('new file is 0600', async () => {
    const { env, path } = makeHome();
    await applyOps([{ op: 'set', key: 'maxConsecutiveFailures', value: 2 }], { env, daemonRunning: noDaemon });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it.skipIf(process.platform === 'win32')('existing mode is preserved', async () => {
    const { env, path } = makeHome();
    writeFileSync(path, '{}\n');
    chmodSync(path, 0o640);
    await applyOps([{ op: 'set', key: 'maxConsecutiveFailures', value: 2 }], { env, daemonRunning: noDaemon });
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });
});

describe('daemon key guard', () => {
  const ops = [
    { op: 'set', key: 'daemon.port', value: 4000 },
    { op: 'set', key: 'daemon', value: { port: 4000 } },
    { op: 'unset', key: 'daemon.port' },
  ] as const;

  it.each(ops)('daemon up: %j -> CONFIG_KEY_READ_ONLY, file unchanged', async (op) => {
    const { env, path } = makeHome();
    writeFileSync(path, '{"daemon":{"port":3000}}\n');
    const before = readFileSync(path);
    let err: CrontickError | undefined;
    try { await applyOps([{ op: 'set', key: 'maxConsecutiveFailures', value: 2 }, op], { env, daemonRunning: up }); } catch (e) { err = e as CrontickError; }
    expect(err?.code).toBe('CONFIG_KEY_READ_ONLY');
    expect(err?.message).toContain('crontick daemon stop');
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('daemon down: daemon.port can be set and unset', async () => {
    const { env, path } = makeHome();
    await applyOps([{ op: 'set', key: 'daemon.port', value: 4000 }], { env, daemonRunning: noDaemon });
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ daemon: { port: 4000 } });
    await applyOps([{ op: 'unset', key: 'daemon.port' }], { env, daemonRunning: noDaemon });
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ daemon: {} });
  });

  it('non-daemon keys are fine while a daemon is up', async () => {
    const { env } = makeHome();
    await applyOps([{ op: 'set', key: 'maxConsecutiveFailures', value: 2 }], { env, daemonRunning: up });
  });

  it('default detector: live pid in daemon.pid blocks, no pid file allows', async () => {
    const { env, path } = makeHome();
    await applyOps([{ op: 'set', key: 'daemon.port', value: 4000 }], { env });
    writeFileSync(join(env.CRONTICK_HOME!, 'daemon.pid'), String(process.pid));
    expect(await codeOf(applyOps([{ op: 'set', key: 'daemon.port', value: 4001 }], { env }))).toBe('CONFIG_KEY_READ_ONLY');
    writeFileSync(join(env.CRONTICK_HOME!, 'daemon.pid'), '2147483646');
    expect(await codeOf(applyOps([{ op: 'set', key: 'daemon.port', value: 4002 }], { env }))).toBe('NO_ERROR');
    expect(JSON.parse(readFileSync(path, 'utf-8')).daemon.port).toBe(4002);
  });
});

describe('secrets', () => {
  const secretEngine = { command: 'tool', args: ['--api-key=hunter2', '-v'], env: { API_TOKEN: 'sekret-value', PLAIN: 'ok' }, type: 'raw' };
  function seed(path: string) {
    writeFileSync(path, JSON.stringify({ engines: { x: secretEngine } }));
  }

  it('redactStoredConfigForRead hides secrets', () => {
    const red = redactStoredConfigForRead({ engines: { x: secretEngine } } as never) as unknown as { engines: { x: { env: Record<string, string> } } };
    expect(red.engines.x.env['API_TOKEN']).toBe(CONFIG_REDACTED_MARKER);
    expect(JSON.stringify(red)).not.toContain('sekret-value');
  });

  it('result config never contains the secret', async () => {
    const { env, path } = makeHome();
    seed(path);
    const res = await applyOps([{ op: 'set', key: 'maxConsecutiveFailures', value: 2 }], { env, daemonRunning: noDaemon });
    expect(JSON.stringify(res)).not.toContain('sekret-value');
    expect(JSON.stringify(res)).not.toContain('hunter2');
  });

  it('echoing the redacted object restores stored secrets (incl. array args)', async () => {
    const { env, path } = makeHome();
    seed(path);
    const echoed = redactValue(secretEngine) as Record<string, unknown>;
    (echoed.env as Record<string, string>).PLAIN = 'changed';
    await applyOps([{ op: 'set', key: 'engines.x', value: echoed }], { env, daemonRunning: noDaemon });
    const stored = JSON.parse(readFileSync(path, 'utf-8')).engines.x;
    expect(stored.env).toEqual({ API_TOKEN: 'sekret-value', PLAIN: 'changed' });
    expect(stored.args).toEqual(['--api-key=hunter2', '-v']);
  });

  it('echoing a single redacted leaf by path restores it', async () => {
    const { env, path } = makeHome();
    seed(path);
    await applyOps([{ op: 'set', key: 'engines.x.env', value: { API_TOKEN: CONFIG_REDACTED_MARKER, PLAIN: 'ok' } }], { env, daemonRunning: noDaemon });
    expect(JSON.parse(readFileSync(path, 'utf-8')).engines.x.env.API_TOKEN).toBe('sekret-value');
  });

  it('a real value replaces the stored secret', async () => {
    const { env, path } = makeHome();
    seed(path);
    await applyOps([{ op: 'set', key: 'engines.x.env', value: { API_TOKEN: 'new-real', PLAIN: 'ok' } }], { env, daemonRunning: noDaemon });
    expect(JSON.parse(readFileSync(path, 'utf-8')).engines.x.env.API_TOKEN).toBe('new-real');
  });

  it('stray marker (no matching stored value) is CONFIG_REDACTED_VALUE, file unchanged', async () => {
    const { env, path } = makeHome();
    seed(path);
    const before = readFileSync(path);
    expect(await codeOf(applyOps([{ op: 'set', key: 'engines.x.env', value: { OTHER_TOKEN: CONFIG_REDACTED_VALUE_PLACEHOLDER() } }], { env, daemonRunning: noDaemon }))).toBe('CONFIG_REDACTED_VALUE');
    expect(await codeOf(applyOps([{ op: 'set', key: 'engines.x.command', value: `a${CONFIG_REDACTED_MARKER}` }], { env, daemonRunning: noDaemon }))).toBe('CONFIG_REDACTED_VALUE');
    expect(await codeOf(applyOps([{ op: 'set', key: 'engines.y', value: { command: 'z', env: { K_TOKEN: CONFIG_REDACTED_MARKER } } }], { env, daemonRunning: noDaemon }))).toBe('CONFIG_REDACTED_VALUE');
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});
function CONFIG_REDACTED_VALUE_PLACEHOLDER(): string { return CONFIG_REDACTED_MARKER; }

describe('locking', () => {
  it('concurrent writers on different keys both persist', async () => {
    const { env, path } = makeHome();
    const keys = ['retention.maxRunsPerJob', 'retention.maxLogFiles', 'maxConsecutiveFailures', 'defaults.timeoutSec', 'logging.fileEnabled'];
    const vals = [7, 8, 9, 10, false];
    await Promise.all(keys.map((key, i) => applyOps([{ op: 'set', key, value: vals[i] }], { env, daemonRunning: noDaemon })));
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
      retention: { maxRunsPerJob: 7, maxLogFiles: 8 }, maxConsecutiveFailures: 9, defaults: { timeoutSec: 10 }, logging: { fileEnabled: false },
    });
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('waits for a held lock and proceeds when released', async () => {
    const { env, path } = makeHome();
    writeFileSync(`${path}.lock`, '1');
    setTimeout(() => rmSync(`${path}.lock`, { force: true }), 150);
    await applyOps([{ op: 'set', key: 'maxConsecutiveFailures', value: 2 }], { env, daemonRunning: noDaemon });
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ maxConsecutiveFailures: 2 });
  });

  it('times out with CONFIG_LOCKED when the lock stays fresh', async () => {
    const { env, path } = makeHome();
    writeFileSync(`${path}.lock`, '1');
    expect(await codeOf(applyOps([{ op: 'set', key: 'maxConsecutiveFailures', value: 2 }], { env, daemonRunning: noDaemon, lockTimeoutMs: 100 }))).toBe('CONFIG_LOCKED');
    expect(existsSync(path)).toBe(false);
  });

  it('breaks a stale lock', async () => {
    const { env, path } = makeHome();
    writeFileSync(`${path}.lock`, '1');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    await applyOps([{ op: 'set', key: 'maxConsecutiveFailures', value: 2 }], { env, daemonRunning: noDaemon });
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('releases the lock after a failed op', async () => {
    const { env, path } = makeHome();
    await expect(applyOps([{ op: 'set', key: 'retention.maxRunsPerJob', value: 0 }], { env, daemonRunning: noDaemon })).rejects.toThrow();
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});
