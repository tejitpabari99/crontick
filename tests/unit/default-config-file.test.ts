import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILT_IN_CONFIG, ensureConfigFile, initConfig, loadConfig } from '../../src/config.js';

const CLI = resolve('dist/cli/index.js');

function cli(args: string[], home: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CRONTICK_HOME: home, CRONTICK_VERBOSE: '' },
    timeout: 30_000,
  });
}

const homes: string[] = [];
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'crontick-defcfg-'));
  homes.push(home);
  return home;
}
afterEach(() => {
  for (const home of homes.splice(0)) {
    cli(['daemon', 'stop'], home);
    rmSync(home, { recursive: true, force: true });
  }
});

describe('ensureConfigFile', () => {
  it('writes the full explicit built-in config with 0600 and round-trips through loadConfig', () => {
    const home = newHome();
    const env = { CRONTICK_HOME: home };
    const result = ensureConfigFile({ env });
    expect(result.created).toBe(true);
    const raw = JSON.parse(readFileSync(result.path, 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['daemon', 'defaultEngine', 'defaults', 'engines', 'logging', 'maxConsecutiveFailures', 'retention']);
    expect(raw['daemon']).toEqual({});
    expect(raw['defaults']).toEqual({ overlap: 'skip', retry: { max: 0, backoffSec: 30 } });
    expect(loadConfig({ env })).toEqual(JSON.parse(JSON.stringify(BUILT_IN_CONFIG)));
    if (process.platform !== 'win32') expect(statSync(result.path).mode & 0o777).toBe(0o600);
  });

  it('never touches an existing file, even an invalid one', () => {
    const home = newHome();
    const path = join(home, 'config.json');
    writeFileSync(path, '{ "defaultEngine": "mine" ', 'utf-8');
    expect(ensureConfigFile({ env: { CRONTICK_HOME: home } })).toEqual({ path, created: false });
    expect(readFileSync(path, 'utf-8')).toBe('{ "defaultEngine": "mine" ');
  });

  it('initConfig writes the same template', () => {
    const home = newHome();
    const env = { CRONTICK_HOME: home };
    const init = initConfig({ env });
    const homeB = newHome();
    ensureConfigFile({ env: { CRONTICK_HOME: homeB } });
    expect(readFileSync(init.path, 'utf-8')).toBe(readFileSync(join(homeB, 'config.json'), 'utf-8'));
  });
});

describe('default config file via the CLI', () => {
  it('info is read-only; the first daemon-backed command creates config.json; edits survive', () => {
    const home = newHome();
    const info = cli(['info'], home);
    expect(info.stdout).toContain('not created yet');
    expect(existsSync(join(home, 'config.json'))).toBe(false);

    expect(cli(['jobs', 'list'], home).status).toBe(0);
    const path = join(home, 'config.json');
    expect(JSON.parse(readFileSync(path, 'utf-8')).defaultEngine).toBe('claude');
    expect(cli(['info'], home).stdout).not.toContain('not created yet');

    const edited = `${JSON.stringify({ defaultEngine: 'claude', defaults: { overlap: 'queue' } }, null, 4)}\n`;
    writeFileSync(path, edited, 'utf-8');
    expect(cli(['jobs', 'list'], home).status).toBe(0);
    cli(['daemon', 'stop'], home);
    expect(cli(['jobs', 'list'], home).status).toBe(0);
    expect(readFileSync(path, 'utf-8')).toBe(edited);
  }, 60_000);
});
