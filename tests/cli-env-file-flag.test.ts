import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const CLI = resolve('dist/cli/index.js');

function cli(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crontick-cli-env-'));
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

function stopDaemonInHome(home: string): void {
  const pidFile = join(home, 'daemon.pid');
  if (!existsSync(pidFile)) return;
  const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  if (!Number.isNaN(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore cleanup failures */ }
  }
}

function waitForTerminalRun(home: string, runId: string, maxMs = 8_000): { status: string; error?: string | null } {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const result = cli(['--json', 'runs', 'get', runId], { CRONTICK_HOME: home });
    if (result.status === 0) {
      const run = JSON.parse(result.stdout) as { status: string; error?: string | null };
      if (run.status !== 'queued' && run.status !== 'running') return run;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`Timed out waiting for run ${runId} to finish`);
}

describe('CLI job env-file flag regression (CTD-010)', () => {
  it('new --help exposes --job-env-file and omits the colliding --env-file flag', () => {
    const result = cli(['new', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--job-env-file <path>');
    expect(result.stdout).not.toContain('--env-file <path>');
  });

  it('a missing --job-env-file path reaches crontick handling instead of a raw Node abort', () => {
    const home = makeTmpDir();
    try {
      const missingEnvFile = join(home, 'does-not-exist.env');
      const created = cli([
        '--json', 'new', 'missing-env-file-job', '--cron', '0 9 * * *',
        '--script', 'echo hi', '--job-env-file', missingEnvFile,
      ], { CRONTICK_HOME: home });
      expect(created.status, created.stderr).toBe(0);
      expect(created.status).not.toBe(9);
      expect(created.stderr).not.toContain('node.exe:');
      expect(JSON.parse(created.stdout).action).toMatchObject({ envFile: missingEnvFile });

      const started = cli(['--json', 'run-now', 'missing-env-file-job'], { CRONTICK_HOME: home });
      expect(started.status, started.stderr).toBe(0);
      const { runId } = JSON.parse(started.stdout) as { runId: string };

      const run = waitForTerminalRun(home, runId);
      expect(run.status).toBe('failed');
      expect(run.error).toContain('Failed to load envFile');
    } finally {
      stopDaemonInHome(home);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});