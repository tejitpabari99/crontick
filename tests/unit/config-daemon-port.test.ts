import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureConfigFile, loadConfig } from '../../src/config.js';
import { PersistedDaemonConfigSchema } from '../../src/schemas/config.js';

const scratchRoot = resolve('.crontick', 'config-daemon-port-tests');
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

describe('daemon.port config', () => {
  it('loads a valid port, including 0 and 65535', () => {
    const { env, path } = makeHome();
    for (const port of [47615, 0, 65535]) {
      writeFileSync(path, JSON.stringify({ daemon: { port } }));
      expect(loadConfig({ env }).daemon).toEqual({ port });
    }
  });

  it('defaults to an empty daemon section (port unset)', () => {
    const { env } = makeHome();
    expect(loadConfig({ env }).daemon).toEqual({});
  });

  it.each([70000, -1, 1.5, 'abc', null])('rejects invalid port %j', (port) => {
    const { env, path } = makeHome();
    writeFileSync(path, JSON.stringify({ daemon: { port } }));
    expect(() => loadConfig({ env })).toThrow();
  });

  it('rejects unknown daemon keys', () => {
    const { env, path } = makeHome();
    writeFileSync(path, JSON.stringify({ daemon: { host: 'x' } }));
    expect(() => loadConfig({ env })).toThrow();
  });

  it('exports a strict persisted daemon schema', () => {
    expect(PersistedDaemonConfigSchema.safeParse({ port: 1 }).success).toBe(true);
    expect(PersistedDaemonConfigSchema.safeParse({}).success).toBe(true);
    expect(PersistedDaemonConfigSchema.safeParse({ port: 70000 }).success).toBe(false);
    expect(PersistedDaemonConfigSchema.safeParse({ nope: 1 }).success).toBe(false);
  });

  it('ensureConfigFile never writes daemon.port', () => {
    const { env, path } = makeHome();
    ensureConfigFile({ env });
    const written = JSON.parse(readFileSync(path, 'utf-8')) as { daemon?: { port?: number } };
    expect(written.daemon?.port).toBeUndefined();
  });
});
