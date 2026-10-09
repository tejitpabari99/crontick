import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_EDIT_NOTICE } from '../../src/constants/config.js';
import { writeTestConfig } from '../helpers/test-home.js';

const CLI = resolve('dist/cli/index.js');
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

let home: string;

function cli(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CRONTICK_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const stored = () => JSON.parse(readFileSync(join(home, 'config.json'), 'utf-8')) as Json;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'crontick-cli-config-')); writeTestConfig(home); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('crontick config', () => {
  it('list prints flat key = value lines with (default) tags', () => {
    const r = cli(['config', 'list']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('daemon.port = 0');
    expect(r.stdout).not.toMatch(/daemon\.port = 0 \(default\)/);
    expect(r.stdout).toMatch(/defaults\.timeoutSec.* \(default\)|defaults\.overlap = "skip" \(default\)/);
  });

  it('list --json prints the structured result', () => {
    const r = cli(['config', 'list', '--json']);
    expect(r.status, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as { config: { daemon: { port: number } }; stored: unknown; revision: string };
    expect(parsed.config.daemon.port).toBe(0);
    expect(parsed.revision).toBeTruthy();
  });

  it('get prints raw strings, JSON otherwise; unknown key errors', () => {
    expect(cli(['config', 'get', 'daemon.port']).stdout.trim()).toBe('0');
    expect(cli(['config', 'get', 'defaultEngine']).stdout.trim()).toBe('claude');
    const bad = cli(['config', 'get', 'nope.nothing']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('error:');
  });

  it('set parses JSON first, notice on stderr, daemon-not-running reload reported', () => {
    const r = cli(['config', 'set', 'defaults.timeoutSec', '90']);
    expect(r.status, r.stderr).toBe(0);
    expect(stored().defaults.timeoutSec).toBe(90);
    expect(r.stdout).toContain('defaults.timeoutSec');
    expect(r.stdout).toContain('daemon-not-running');
    expect(r.stderr).toContain(CONFIG_EDIT_NOTICE);
    expect(r.stdout).not.toContain(CONFIG_EDIT_NOTICE);
  });

  it('set falls back to the raw string and --string forces a string', () => {
    expect(cli(['config', 'set', 'defaultEngine', 'claude']).status).toBe(0);
    expect(stored().defaultEngine).toBe('claude');
    const r = cli(['config', 'set', 'engines.num', '{"command":"123","type":"raw"}']);
    expect(r.status, r.stderr).toBe(0);
    expect(stored().engines.num).toEqual({ command: '123', type: 'raw' });
    const s = cli(['config', 'set', '--string', 'engines.num.command', '456']);
    expect(s.status, s.stderr).toBe(0);
    expect(stored().engines.num.command).toBe('456');
    expect(cli(['config', 'set', 'engines.num.command', '789']).status).toBe(1);
  });

  it('set arrays via JSON', () => {
    const r = cli(['config', 'set', 'engines.x', '{"command":"c","type":"raw"}']);
    expect(r.status, r.stderr).toBe(0);
    const a = cli(['config', 'set', 'engines.x.args', '["-p","--verbose"]']);
    expect(a.status, a.stderr).toBe(0);
    expect(stored().engines.x.args).toEqual(['-p', '--verbose']);
  });

  it('unset removes the key; engines go through unset engines.<name>', () => {
    cli(['config', 'set', 'engines.x', '{"command":"c","type":"raw"}']);
    const r = cli(['config', 'unset', 'engines.x']);
    expect(r.status, r.stderr).toBe(0);
    expect(stored().engines?.x).toBeUndefined();
    expect(r.stderr).toContain(CONFIG_EDIT_NOTICE);
  });

  it('invalid value errors and writes nothing', () => {
    const r = cli(['config', 'set', 'defaults.timeoutSec', '--', '-5']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('CONFIG_VALIDATION_ERROR');
    expect(stored().defaults).toBeUndefined();
  });

  it('rejects --stop-running together with --wait-running', () => {
    const r = cli(['config', 'set', '--stop-running', '--wait-running', 'defaults.timeoutSec', '1']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('only one');
  });

  it('help lists the in-flight flags', () => {
    const r = cli(['config', 'set', '--help']);
    expect(r.stdout).toContain('--stop-running');
    expect(r.stdout).toContain('--wait-running');
    expect(r.stdout).toContain('--string');
  });
});
