import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

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

function readPositiveNumber(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const value = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function readPid(): number | undefined {
  return readPositiveNumber(pidFile());
}

function readPort(): number | undefined {
  return readPositiveNumber(portFile());
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
  try { cli(['info', 'daemon', 'stop']); } catch { /* ignore */ }
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

describe('daemon lifecycle CLI human output', () => {
  it('daemon-backed commands demand-start the daemon and emit human-readable output', () => {
    const result = cli(['jobs', 'list']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('(no items)');
    expect(readPid()).toBeGreaterThan(0);
    expect(readPort()).toBeGreaterThan(0);
  }, 15_000);

  it('info daemon stop emits the stop message and mode', () => {
    const started = cli(['jobs', 'list']);
    expect(started.status, started.stderr).toBe(0);
    const previousPid = readPid();
    expect(previousPid).toBeGreaterThan(0);

    const result = cli(['info', 'daemon', 'stop']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toContain(`Stopped daemon (pid ${String(previousPid)})`);
    expect(result.stdout.trim()).toMatch(/\(mode: (graceful|hard-kill)\)$/);
    if (previousPid !== undefined) waitForPidExit(previousPid);
  }, 15_000);

  it('info daemon reload emits one human-readable result for the running daemon', () => {
    const started = cli(['jobs', 'list']);
    expect(started.status, started.stderr).toBe(0);
    expect(readPid()).toBeGreaterThan(0);
    const previousPort = readPort();

    const result = cli(['info', 'daemon', 'reload']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('ok: true');
    expect(readPid()).toBeGreaterThan(0);
    expect(readPort()).toBe(previousPort);
  }, 20_000);
});
