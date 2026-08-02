import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const CLI = resolve('dist', 'cli', 'index.js');
const SCRATCH_ROOT = resolve('.crontick', 'cli-daemon-json-ctd-013');
let home = '';

function pidFile(): string {
  return join(home, 'daemon.pid');
}

function portFile(): string {
  return join(home, 'daemon.port');
}

function cli(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CRONTICK_HOME: home },
  });
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readPid(): number | undefined {
  if (!existsSync(pidFile())) return undefined;
  const pid = Number.parseInt(readFileSync(pidFile(), 'utf8').trim(), 10);
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
  if (!home) return;
  stopDaemon();
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, 'jobs'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
}

function removeHome(): void {
  if (!home) return;
  stopDaemon();
  rmSync(home, { recursive: true, force: true });
}

beforeEach(() => {
  home = join(SCRATCH_ROOT, randomUUID());
  resetHome();
});

afterEach(() => {
  removeHome();
  home = '';
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
    expect(existsSync(portFile())).toBe(true);
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
    expect(existsSync(pidFile())).toBe(false);
    expect(existsSync(portFile())).toBe(false);
  });
});
