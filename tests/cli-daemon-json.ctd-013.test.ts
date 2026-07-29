import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CLI = resolve('dist', 'cli', 'index.js');
const HOME = String.raw`Q:\Rough\crontick-qa\state\devfix2\cli-daemon-json-ctd-013`;
const PID_FILE = join(HOME, 'daemon.pid');
const PORT_FILE = join(HOME, 'daemon.port');

function cli(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CRONTICK_HOME: HOME },
  });
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readPid(): number | undefined {
  if (!existsSync(PID_FILE)) return undefined;
  const pid = Number.parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function waitForPidExit(pid: number, maxMs = 5_000): void {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      sleep(50);
    } catch {
      return;
    }
  }
}

function stopDaemon(): void {
  try { cli(['--json', 'daemon', 'stop']); } catch { /* ignore */ }
  const pid = readPid();
  if (pid === undefined) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  waitForPidExit(pid);
}

function resetHome(): void {
  stopDaemon();
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(HOME, 'jobs'), { recursive: true });
  mkdirSync(join(HOME, 'logs'), { recursive: true });
}

beforeEach(() => {
  resetHome();
});

afterEach(() => {
  resetHome();
});

describe('CTD-013 daemon lifecycle CLI JSON output', () => {
  it('daemon start --json emits one parseable structured result', () => {
    const result = cli(['--json', 'daemon', 'start']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');

    const payload = JSON.parse(result.stdout) as {
      ok: true;
      started: boolean;
      pid?: number;
      port?: number;
      baseUrl?: string;
    };

    expect(payload).toMatchObject({ ok: true, started: true });
    expect(payload.pid).toBeGreaterThan(0);
    expect(payload.port).toBeGreaterThan(0);
    expect(payload.baseUrl).toBe(`http://127.0.0.1:${String(payload.port)}`);
    expect(readPid()).toBe(payload.pid);
    expect(existsSync(PORT_FILE)).toBe(true);
  }, 15_000);

  it('daemon restart --json emits one parseable structured result', () => {
    const started = cli(['daemon', 'start']);
    expect(started.status, started.stderr).toBe(0);
    const previousPid = readPid();
    expect(previousPid).toBeGreaterThan(0);

    const result = cli(['--json', 'daemon', 'restart']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');

    const payload = JSON.parse(result.stdout) as {
      ok: true;
      started: boolean;
      stopped: boolean;
      previousPid?: number;
      pid?: number;
      port?: number;
      baseUrl?: string;
    };

    expect(payload).toMatchObject({ ok: true, started: true, stopped: true, previousPid });
    expect(payload.pid).toBeGreaterThan(0);
    expect(payload.port).toBeGreaterThan(0);
    expect(payload.baseUrl).toBe(`http://127.0.0.1:${String(payload.port)}`);
    expect(readPid()).toBe(payload.pid);
  }, 20_000);

  it('daemon start --foreground --json fails fast with a validation error and does not launch the daemon', () => {
    const result = cli(['--json', 'daemon', 'start', '--foreground']);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe('');

    const payload = JSON.parse(result.stderr) as { code?: string; message: string };
    expect(payload.code).toBe('VALIDATION_ERROR');
    expect(payload.message).toContain('--foreground');
    expect(payload.message).toContain('--json');
    expect(payload.message).toContain('single JSON object');
    expect(existsSync(PID_FILE)).toBe(false);
    expect(existsSync(PORT_FILE)).toBe(false);
  });
});
