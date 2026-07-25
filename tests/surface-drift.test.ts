import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CrontickClient } from '../src/client.js';
import { SURFACE_CAPABILITIES } from '../src/surface.js';

const CLI = resolve('dist/cli/index.js');
const MCP = resolve('dist/mcp/index.js');

function scratchHome(): string {
  const home = resolve('.crontick', 'surface-drift', randomUUID());
  mkdirSync(join(home, 'jobs'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
  return home;
}

describe('surface capability drift', () => {
  it('client exposes every table capability method', () => {
    for (const capability of SURFACE_CAPABILITIES) {
      expect(
        typeof CrontickClient.prototype[capability.clientMethod as keyof CrontickClient],
        `${capability.capability} missing client method ${capability.clientMethod}`,
      ).toBe('function');
    }
  });

  it('CLI exposes every table capability command', () => {
    const home = scratchHome();
    const seen = new Set<string>();
    try {
      for (const capability of SURFACE_CAPABILITIES) {
        const command = capability.cliCommand.join(' ');
        if (seen.has(command)) continue;
        seen.add(command);
        const result = spawnSync(process.execPath, [CLI, ...capability.cliCommand, '--help'], {
          encoding: 'utf-8',
          env: { ...process.env, CRONTICK_HOME: home },
        });

        expect(result.status, `${command} help failed: ${result.stderr}`).toBe(0);
        expect(result.stdout + result.stderr).toContain(capability.cliCommand.at(-1));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('CLI exposes global verbose flag without replacing version flag', () => {
    const home = scratchHome();
    const result = spawnSync(process.execPath, [CLI, '--help'], {
      encoding: 'utf-8',
      env: { ...process.env, CRONTICK_HOME: home },
    });
    try {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('-V, --version');
      expect(result.stdout).toContain('-v, --verbose');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('MCP exposes every table capability tool', async () => {
    const home = scratchHome();
    let transport: StdioClientTransport | undefined;
    let client: Client | undefined;
    try {
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [MCP],
        env: { ...process.env, CRONTICK_HOME: home, CRONTICK_MCP_START_DAEMON: '0' },
        stderr: 'pipe',
      });
      client = new Client({ name: 'surface-drift-test', version: '0.0.0' }, { capabilities: {} });
      await client.connect(transport);
      const listed = await client.listTools();
      const names = new Set(listed.tools.map((tool) => tool.name));
      for (const capability of SURFACE_CAPABILITIES) {
        expect(names.has(capability.mcpTool), `${capability.capability} missing MCP tool ${capability.mcpTool}`).toBe(true);
      }
      for (const tool of listed.tools.filter((tool) => tool.name.startsWith('crontick_'))) {
        const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
        expect(properties, `${tool.name} missing verbose option`).toHaveProperty('verbose');
      }
    } finally {
      try { await client?.close(); } catch { /* ignore */ }
      try { await transport?.close(); } catch { /* ignore */ }
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
