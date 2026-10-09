import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = resolve('dist/cli/index.js');
function cli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

describe('crontick autostart CLI', () => {
  it('lists enable, disable, status subcommands', () => {
    const r = cli(['autostart', '--help'], {});
    expect(r.status).toBe(0);
    for (const sub of ['enable', 'disable', 'status']) expect(r.stdout).toContain(sub);
  });

  it('status is read-only, needs no daemon, and exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crontick-as-'));
    try {
      const r = cli(['autostart', 'status'], { CRONTICK_HOME: dir, XDG_CONFIG_HOME: join(dir, 'xdg'), CRONTICK_NO_DAEMON_START: '1' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/autostart\s+(enabled|disabled|unsupported)/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
