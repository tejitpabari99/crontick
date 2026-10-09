import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Scheduler } from '../../src/daemon/scheduler.js';
import { Store } from '../../src/daemon/store.js';
import { createLogger, type LogEvent } from '../../src/logger.js';
import { writeTestConfig } from '../helpers/test-home.js';

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
  const home = mkdtempSync(join(tmpdir(), 'crontick-jobopts-'));
  homes.push(home);
  writeTestConfig(home);
  return home;
}
afterEach(() => {
  for (const home of homes.splice(0)) {
    cli(['daemon', 'stop'], home);
    rmSync(home, { recursive: true, force: true });
  }
});

/** Long (and short) option flags listed under "Options:" in a command's --help output. */
function optionFlags(help: string): Set<string> {
  const flags = new Set<string>();
  const options = help.split('Options:')[1] ?? '';
  for (const line of options.split('\n')) {
    const match = /^ {2}((?:-\w, )?--[\w-]+)/.exec(line);
    if (match) flags.add(match[1]!);
  }
  return flags;
}

describe('jobs new / jobs update option parity', () => {
  it('differ only by --force vs --enable/--disable', () => {
    const home = newHome();
    const created = optionFlags(cli(['jobs', 'new', '--help'], home).stdout);
    const updated = optionFlags(cli(['jobs', 'update', '--help'], home).stdout);
    const onlyNew = [...created].filter((flag) => !updated.has(flag)).sort();
    const onlyUpdate = [...updated].filter((flag) => !created.has(flag)).sort();
    expect(onlyNew).toEqual(['--force']);
    expect(onlyUpdate).toEqual(['--disable', '--enable', '--unset']);
    // Guard against the parser silently matching nothing.
    expect(created.size).toBeGreaterThan(10);
    expect(created.has('-a, --alias')).toBe(true);
    expect(created.has('-p, --prompt')).toBe(true);
  });

  it('shows the same option help strings on update as on new', () => {
    const home = newHome();
    const normalize = (text: string): string => text.replace(/\s+/g, ' ');
    for (const sub of ['new', 'update']) {
      const help = normalize(cli(['jobs', sub, '--help'], home).stdout);
      expect(help, sub).toContain('--overlap <policy> Overlap policy: skip|queue|cancel-previous (default: skip)');
      expect(help, sub).toContain('--session-id <id> Resume an existing session ID on every run (implies reuse)');
    }
  });
});

describe('short flags -a and -p', () => {
  it('create a job via -a/-p, and short flags after -- still pass through to the engine', () => {
    const home = newHome();
    const created = cli(['jobs', 'new', '-a', 'short-flags', '-p', 'say hi', '--every', '1h', '--', '-v'], home);
    expect(created.status, created.stderr).toBe(0);
    const got = cli(['jobs', 'get', 'short-flags'], home);
    expect(got.stdout).toContain('"prompt":"say hi"');
    expect(got.stdout).toContain('"args":["-v"]');
    const updated = cli(['jobs', 'update', 'short-flags', '-p', 'say bye'], home);
    expect(updated.status, updated.stderr).toBe(0);
    expect(updated.stdout).toContain('say bye');
  }, 60_000);

  it('rejects the removed --tz flag instead of storing it as an engine argument', () => {
    const home = newHome();
    const result = cli(['jobs', 'new', '-p', 'x', '--cron', '0 9 * * *', '--tz', 'UTC'], home);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown option '--tz'");
  }, 30_000);
});

describe('--dir replaces -C/--cwd', () => {
  const base = ['jobs', 'new', '-p', 'x', '--every', '1h'];

  it('--dir is documented on new/update and -C/--cwd are gone from help', () => {
    const home = newHome();
    for (const sub of ['new', 'update']) {
      const help = cli(['jobs', sub, '--help'], home).stdout.replace(/\s+/g, ' ');
      expect(help, sub).toContain('--dir <path> Directory the job runs in (default: current directory)');
      expect(help, sub).not.toContain('--cwd');
      expect(help, sub).not.toContain('-C,');
    }
  });

  it.each([
    [['--cwd', '/tmp'], '--cwd'],
    [['-C', '/tmp'], '-C'],
    [['--', '--cwd', '/tmp'], '--cwd'],
    [['--', '--cwd=/tmp'], '--cwd'],
    [['--', '-C', '/tmp'], '-C'],
  ])('rejects %j as an unknown option', (extra, flag) => {
    const home = newHome();
    const result = cli([...base, ...extra], home);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`unknown option '${flag}'`);
  }, 30_000);

  it('-d is never consumed and passes to the engine after --', () => {
    const home = newHome();
    const created = cli([...base, '-a', 'dash-d', '--', '-d'], home);
    expect(created.status, created.stderr).toBe(0);
    expect(cli(['jobs', 'get', 'dash-d'], home).stdout).toContain('"args":["-d"]');
  }, 60_000);
});

describe('cron fires in machine local time', () => {
  const original = process.env['TZ'];
  afterEach(() => {
    if (original === undefined) delete process.env['TZ'];
    else process.env['TZ'] = original;
  });

  it.each(['America/New_York', 'Asia/Kolkata', 'UTC'])('previews 09:00 local under TZ=%s', (zone) => {
    process.env['TZ'] = zone;
    const next = new Scheduler().previewNext({ kind: 'cron', cron: '0 9 * * *' }, { n: 3 });
    expect(next).toHaveLength(3);
    for (const iso of next) {
      const d = new Date(iso);
      expect(d.getHours()).toBe(9);
      expect(d.getMinutes()).toBe(0);
    }
  });
});

describe('stored schedule.tz', () => {
  it('is silently ignored at load: nothing is warned, logged or published', () => {
    const dir = newHome();
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    const id = '11111111-1111-4111-8111-111111111111';
    writeFileSync(join(dir, 'jobs', `${id}.json`), JSON.stringify({
      id,
      alias: 'stored-tz',
      enabled: true,
      schedule: { kind: 'cron', cron: '0 9 * * *', tz: 'Europe/London' },
      action: { kind: 'prompt', prompt: 'x', args: [], reuseSession: false },
    }), 'utf-8');
    const events: LogEvent[] = [];
    const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'), createLogger({ level: 'debug', sink: (event) => events.push(event) }));
    store.open();
    try {
      store.loadJobsFromDisk();
      expect(store.getJob(id)?.schedule).toEqual({ kind: 'cron', cron: '0 9 * * *' });
      expect(events.filter((e) => /tz|timezone/i.test(`${e.message} ${JSON.stringify(e.data ?? {})}`))).toEqual([]);
      expect(events.filter((e) => e.level === 'warn' || e.level === 'error')).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe('jobs update --unset', () => {
  it('clears timeout, session-id and desc; usage errors for unknown field and setter conflicts', () => {
    const home = newHome();
    const dir = mkdtempSync(join(tmpdir(), 'crontick-unset-dir-'));
    homes.push(dir);
    const made = cli(['jobs', 'new', '-a', 'unset-me', '-p', 'hi', '--every', '1h', '--dir', dir, '--timeout', '30', '--session-id', 'sess-abc', '--desc', 'hello'], home);
    expect(made.status, made.stderr).toBe(0);
    const before = cli(['jobs', 'get', 'unset-me'], home).stdout;
    expect(before).toContain('"timeoutSec":30');
    expect(before).toContain('"sessionId":"sess-abc"');
    expect(before).toMatch(/description: hello/);

    const t = cli(['jobs', 'update', 'unset-me', '--unset', 'timeout'], home);
    expect(t.status, t.stderr).toBe(0);
    expect(t.stdout).not.toContain('timeoutSec');
    expect(t.stdout).toContain('"sessionId":"sess-abc"');

    const rest = cli(['jobs', 'update', 'unset-me', '--unset', 'session-id', '--unset', 'desc'], home);
    expect(rest.status, rest.stderr).toBe(0);
    expect(rest.stdout).not.toContain('sessionId');
    expect(rest.stdout).not.toMatch(/description:/);
    const after = cli(['jobs', 'get', 'unset-me'], home).stdout;
    expect(after).not.toContain('sessionId');
    expect(after).not.toMatch(/description:/);

    const bad = cli(['jobs', 'update', 'unset-me', '--unset', 'cwd'], home);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/Unknown --unset field/);
    const conflict = cli(['jobs', 'update', 'unset-me', '--unset', 'desc', '--desc', 'x'], home);
    expect(conflict.status).not.toBe(0);
    expect(conflict.stderr).toMatch(/--unset desc/);
  }, 60_000);
});
