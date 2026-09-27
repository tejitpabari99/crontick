import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guards the removal of the `dashboard` command group from the CLI and MCP
 * surfaces. The dashboard itself is NOT removed -- it is always served by the
 * daemon on its loopback port (routes '/', '/dashboard', '/dashboard/*'). There
 * is therefore no need for `crontick dashboard start/status/stop`; users get the
 * dashboard URL from `crontick info` and open it in a browser.
 *
 * This test asserts BOTH: the commands/tools are gone AND the dashboard URL is
 * surfaced by `info` (verified in cli.test.ts / mcp.test.ts).
 */

const CLI = resolve('dist/cli/index.js');

function cli(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

const REMOVED_DASHBOARD_SUBCOMMANDS = ['start', 'status', 'stop'] as const;

describe('dashboard command removal', () => {
  it('`crontick dashboard` is no longer a registered command (clean error, exit 1)', () => {
    const result = cli(['dashboard']);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("error: unknown command 'dashboard'");
    // No Node stack trace leaks to the user.
    expect(result.stderr).not.toMatch(/\n\s+at\s/);
  });

  it('each former `dashboard <sub>` invocation errors as an unknown command', () => {
    for (const sub of REMOVED_DASHBOARD_SUBCOMMANDS) {
      const result = cli(['dashboard', sub]);
      expect(result.status, `dashboard ${sub}: ${result.stderr}`).toBe(1);
      expect(result.stderr).toContain('unknown command');
      expect(result.stderr).toContain('dashboard');
    }
  });

  it('`crontick --help` does not list a dashboard command', () => {
    const help = cli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).not.toContain('dashboard');
  });

  it('the CLI source no longer registers a dashboard command group', () => {
    const source = readFileSync(resolve('src/cli/index.ts'), 'utf-8');
    expect(source).not.toContain(".command('dashboard')");
    expect(source).not.toContain('dashboardStart');
    expect(source).not.toContain('dashboardStop');
  });

  it('the MCP source no longer registers dashboard tools', () => {
    const source = readFileSync(resolve('src/mcp/index.ts'), 'utf-8');
    for (const tool of ['crontick_dashboard_start', 'crontick_dashboard_status', 'crontick_dashboard_stop']) {
      expect(source, `MCP must not register ${tool}`).not.toContain(tool);
    }
  });
});
