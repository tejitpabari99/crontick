/**
 * MCP autostart tool tests.
 * Starts a real daemon + MCP server, drives them via the MCP client SDK.
 *
 * - crontick_autostart_status: always works (returns manual or win32)
 * - crontick_autostart_install / remove: win32 only; skip on other platforms
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const DAEMON_SCRIPT = resolve('dist/daemon/index.js');
const MCP_SCRIPT = resolve('dist/mcp/index.js');
const TIMEOUT_MS = 60_000;

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'crontick-mcp-as-'));
  mkdirSync(join(d, 'jobs'), { recursive: true });
  mkdirSync(join(d, 'logs'), { recursive: true });
  return d;
}

function waitForPortFile(dir: string, maxMs = 30_000, getStderr?: () => string): Promise<number> {
  const portFile = join(dir, 'daemon.port');
  return new Promise((res, rej) => {
    let attempts = 0;
    const max = Math.ceil(maxMs / 250);
    const check = () => {
      if (existsSync(portFile)) {
        try {
          const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
          if (!isNaN(port) && port > 0) return res(port);
        } catch { /* retry */ }
      }
      if (++attempts >= max) return rej(new Error(`Daemon timed out${getStderr?.() ? `\n${getStderr()}` : ''}`));
      setTimeout(check, 250);
    };
    check();
  });
}

async function callTool(c: Client, name: string, args: Record<string, unknown> = {}) {
  const raw = await c.callTool({ name, arguments: args });
  const result = raw as unknown as ToolResult;
  const text = (result.content[0]?.text as string | undefined) ?? '';
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { json, isError: result.isError === true, text };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('MCP autostart tools', () => {
  let dir: string;
  let daemonProc: ChildProcess;
  let client: Client;
  let transport: StdioClientTransport;
  const testValueName = `crontick-daemon-test-${process.pid}`;

  beforeAll(async () => {
    dir = makeTmpDir();
    const stderrChunks: string[] = [];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CRONTICK_HOME: dir,
      CRONTICK_MCP_NO_AUTOSTART: '1',
      CRONTICK_AUTOSTART_TEST_VALUE: testValueName,
      CRONTICK_DAEMON_BINARY: 'dist\\daemon\\index.js',
    };
    daemonProc = spawn(process.execPath, [DAEMON_SCRIPT], { env, stdio: 'pipe' });
    daemonProc.stderr?.on('data', (c: Buffer) => stderrChunks.push(c.toString()));
    await waitForPortFile(dir, 30_000, () => stderrChunks.join(''));

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_SCRIPT],
      env: env as Record<string, string>,
    });
    client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
  }, TIMEOUT_MS);

  afterAll(async () => {
    try { await client?.close(); } catch { /* ignore */ }
    daemonProc?.kill('SIGTERM');
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('crontick_autostart_status returns backend field', async () => {
    const { json, isError } = await callTool(client, 'crontick_autostart_status');
    expect(isError).toBe(false);
    const d = json as Record<string, unknown>;
    expect(['win32', 'darwin', 'linux', 'manual']).toContain(d['backend']);
    expect(typeof d['installed']).toBe('boolean');
  });

  describe.skipIf(process.platform !== 'win32')('win32 install/remove (Windows only)', () => {
    it('install → status (installed) → remove round-trip', async () => {
      const install = await callTool(client, 'crontick_autostart_install');
      expect(install.isError).toBe(false);
      expect((install.json as Record<string, unknown>)?.['ok']).toBe(true);

      const status = await callTool(client, 'crontick_autostart_status');
      expect((status.json as Record<string, unknown>)?.['installed']).toBe(true);

      const remove = await callTool(client, 'crontick_autostart_remove');
      expect(remove.isError).toBe(false);
      expect((remove.json as Record<string, unknown>)?.['ok']).toBe(true);
    });
  });
});
