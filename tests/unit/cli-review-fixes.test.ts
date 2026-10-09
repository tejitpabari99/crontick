import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('dist/cli/index.js');

function cli(args: string[], home: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CRONTICK_HOME: home, CRONTICK_VERBOSE: '' },
    timeout: 30_000,
  });
}

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'crontick-review-'));
  try {
    return fn(home);
  } finally {
    // The daemon is never started by these tests; nothing to stop.
    rmSync(home, { recursive: true, force: true });
  }
}

describe('jobs new help and schedule errors', () => {
  it('orders options name, prompt, schedule flags, then the rest, with description last', () => withHome((home) => {
    const help = cli(['jobs', 'new', '--help'], home).stdout.replace(/[ ]*\n[ ]*/g, ' ').replace(/ {2,}/g, ' ');
    const order = ['--alias', '--prompt <text>', '--cron', '--every', '--at', '--session-id', '--desc'].map((flag) => help.indexOf(flag));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Each schedule flag appears exactly once (no duplicate "Schedule:" block) and --tz is gone.
    for (const flag of ['--cron <expr>', '--every <interval>', '--at <datetime>']) {
      expect(help.split(flag).length - 1, flag).toBe(1);
    }
    expect(help).not.toContain('--tz');
    expect(help).not.toMatch(/timezone/i);
    expect(help).toContain('--cron <expr> Schedule: cron expression');
    expect(help).toContain('-a, --alias <alias> Unique kebab-case job alias (auto-generated when omitted)');
    expect(help).toContain('-p, --prompt <text>');
    expect(help).toContain('--session-id <id> Resume an existing session ID on every run (implies reuse)');
    expect(help).toContain('--reuse-session Start a new session and resume it on succeeding runs.');
    expect(help).toContain('--overlap <policy> Overlap policy: skip|queue|cancel-previous (default: skip)');
    expect(help).toMatch(/same alias/i);
  }));

  it('explains all three schedule flags when none is given', () => withHome((home) => {
    const result = cli(['jobs', 'new', '--alias', 'sample', '--prompt', 'hi'], home);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MISSING_ARG');
    expect(result.stderr).toContain('--every <interval> (seconds, or a s/m/h/d suffix such as 30m)');
    expect(result.stderr).toContain('--at <datetime>');
    expect(result.stderr).toContain('local timezone unless an offset is given');
  }));

  it('rejects more than one schedule flag', () => withHome((home) => {
    const result = cli(['jobs', 'new', '--prompt', 'hi', '--cron', '* * * * *', '--every', '30m'], home);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Provide only one schedule');
  }));
});

describe('info, doctor and daemon commands', () => {
  it('info lists no commands and reports a missing config file truthfully', () => withHome((home) => {
    const result = cli(['info'], home);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('not created yet');
    expect(result.stdout).not.toMatch(/^commands\b/m);
    expect(result.stdout).not.toMatch(/^ {2}daemon start\b/m);
    expect(result.stdout).not.toContain('info daemon');
  }));

  it('doctor reports the data dir and whether the config file exists', () => withHome((home) => {
    const result = cli(['doctor'], home);
    expect(result.stdout).toContain(`data dir writable (${home})`);
    expect(result.stdout).toMatch(/config file .*config\.json - not created yet, built-in defaults in use/);
  }));

  it('daemon status reports a stopped daemon without starting it', () => withHome((home) => {
    const result = cli(['daemon', 'status'], home);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('not running');
    expect(result.stdout).toContain('crontick daemon start');
  }));

  it('daemon start starts the daemon explicitly and daemon stop stops it', () => withHome((home) => {
    try {
      const started = cli(['daemon', 'start'], home);
      expect(started.status, started.stderr).toBe(0);
      expect(started.stdout).toMatch(/Daemon (started|already running) \(pid \d+, http:\/\/127\.0\.0\.1:\d+\)/);
      const again = cli(['daemon', 'start'], home);
      expect(again.stdout).toContain('already running');
      const status = cli(['daemon', 'status'], home);
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).toContain('pid');
    } finally {
      const stopped = cli(['daemon', 'stop'], home);
      expect(stopped.status, stopped.stderr).toBe(0);
    }
  }));
});
