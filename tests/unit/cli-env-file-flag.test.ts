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

describe('CLI job env-file flag regression (CTD-010)', () => {
  it('new --help exposes --job-env-file and omits the colliding --env-file flag', () => {
    const result = cli(['new', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--job-env-file <path>');
    expect(result.stdout).not.toContain('--env-file <path>');
  });

  it('a missing --job-env-file path fails create before persistence and avoids a raw Node abort', () => {
    const home = makeTmpDir();
    try {
      const missingEnvFile = join(home, 'does-not-exist.env');
      const created = cli([
        '--json', 'new', 'missing-env-file-job', '--cron', '0 9 * * *',
        '--script', 'echo hi', '--job-env-file', missingEnvFile,
      ], { CRONTICK_HOME: home });
      expect(created.status, created.stderr).toBe(1);
      expect(created.status).not.toBe(9);
      expect(created.stderr).not.toContain('node.exe:');
      const payload = JSON.parse(created.stderr) as { code: string; message: string };
      expect(payload.code).toBe('ENV_FILE_ERROR');
      expect(payload.message).toContain(missingEnvFile);

      const listed = cli(['--json', 'list'], { CRONTICK_HOME: home });
      expect(listed.status, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout)).toEqual([]);
    } finally {
      stopDaemonInHome(home);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});
