import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const scratchRoot = resolve('.crontick', 'library-consumer-exit-ctd-009');

function makeHome(): string {
  mkdirSync(scratchRoot, { recursive: true });
  const home = join(scratchRoot, randomUUID());
  mkdirSync(join(home, 'jobs'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
  return home;
}

function killHomeDaemon(home: string): void {
  const pidPath = join(home, 'daemon.pid');
  if (!existsSync(pidPath)) return;
  const pid = Number(readFileSync(pidPath, 'utf-8'));
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore cleanup failures
    }
  }
}

describe('CTD-009 library consumer exit', () => {
  it('lets createClient consumers call process.exit() immediately after a daemon-backed request without a native crash', async () => {
    const home = makeHome();
    try {
      const script = join(home, 'library-consumer-exit.mjs');
      const distIndexUrl = pathToFileURL(resolve('dist', 'index.js')).href;
      writeFileSync(script, [
        `import { createClient } from ${JSON.stringify(distIndexUrl)};`,
        'const client = createClient({ startupTimeoutMs: 10000 });',
        'await client.listJobs();',
        'process.exit(0);',
        '',
      ].join('\n'), 'utf-8');

      const result = spawnSync(process.execPath, [script], {
        encoding: 'utf-8',
        env: { ...process.env, CRONTICK_HOME: home },
        timeout: 20_000,
        windowsHide: true,
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`).toBe(0);
      if (process.platform === 'win32') {
        expect(result.stderr).not.toMatch(/Assertion failed: .*UV_HANDLE_CLOSING|libuv|undici/i);
      }
    } finally {
      killHomeDaemon(home);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      rmSync(home, { recursive: true, force: true });
    }
  }, 25_000);
});
