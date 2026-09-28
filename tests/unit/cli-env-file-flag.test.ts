import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const CLI = resolve('dist', 'cli', 'index.js');
const SCRATCH_ROOT = resolve('.crontick', 'cli-env-file-flag');

function cli(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function makeHome(): string {
  const dir = join(SCRATCH_ROOT, randomUUID());
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

function stopDaemonInHome(home: string): void {
  const pidFile = join(home, 'daemon.pid');
  if (!existsSync(pidFile)) return;
  const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  try { cli(['daemon', 'stop'], { CRONTICK_HOME: home }); } catch { /* ignore cleanup failures */ }
  if (!Number.isNaN(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore cleanup failures */ }
  }
}

function parseDisplay(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (trimmed === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^[{["]/.test(trimmed)) try { return JSON.parse(trimmed); } catch { /* keep string */ }
  return value;
}

function parseCliObject<T extends Record<string, unknown> = Record<string, unknown>>(stdout: string): T {
  const out: Record<string, unknown> = {};
  for (const line of stdout.trim().split(/\r?\n/)) {
    const idx = line.indexOf(': ');
    if (idx >= 0) out[line.slice(0, idx)] = parseDisplay(line.slice(idx + 2));
  }
  return out as T;
}

describe('CLI job env-file flag regression (CTD-010)', () => {
  it('jobs new --help does not expose the removed --job-env-file flag', () => {
    const result = cli(['jobs', 'new', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('--job-env-file');
    expect(result.stdout).not.toContain('--env-file <path>');
  });

  it('jobs new rejects the removed --job-env-file option before persistence', () => {
    const home = makeHome();
    try {
      const missingEnvFile = join(home, 'does-not-exist.env');
      const created = cli([
        'jobs', 'new', '--name', 'removed-env-file-job', '--cron', '0 9 * * *',
        '--prompt', 'echo hi', '--job-env-file', missingEnvFile,
      ], { CRONTICK_HOME: home });

      expect(created.status, created.stderr).toBe(1);
      expect(created.stdout).toBe('');
      expect(created.stderr.trim()).toBe("error: unknown option '--job-env-file'");
      expect(existsSync(join(home, 'daemon.pid'))).toBe(false);
      expect(existsSync(join(home, 'jobs', 'removed-env-file-job.json'))).toBe(false);
    } finally {
      stopDaemonInHome(home);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('jobs new --file remains the supported path for job environment values', () => {
    const home = makeHome();
    try {
      const jobFile = join(home, 'env-job.json');
      writeFileSync(jobFile, JSON.stringify({
        alias: 'file-env-job',
        schedule: { kind: 'cron', cron: '0 9 * * *' },
        action: {
          kind: 'prompt',
          prompt: 'noop',
          env: { VISIBLE_ENV: 'kept' },
        },
      }, null, 2), 'utf-8');

      const created = cli(['jobs', 'new', '--file', jobFile], { CRONTICK_HOME: home });
      expect(created.status, created.stderr).toBe(0);
      expect(parseCliObject(created.stdout).action).toMatchObject({
        kind: 'prompt',
        env: { VISIBLE_ENV: 'kept' },
      });
    } finally {
      stopDaemonInHome(home);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});
