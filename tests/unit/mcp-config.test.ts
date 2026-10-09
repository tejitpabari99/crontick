import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CONFIG_EDIT_NOTICE } from '../../src/constants/config.js';
import { writeTestConfig } from '../helpers/test-home.js';

const MCP = resolve('dist/mcp/index.js');
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

let home: string;
let client: Client;
let transport: StdioClientTransport;

async function call(name: string, args: Record<string, unknown>) {
  const raw = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  return { isError: raw.isError === true, json: JSON.parse(raw.content[0]!.text) as Json };
}
const stored = () => JSON.parse(readFileSync(join(home, 'config.json'), 'utf-8')) as Json;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'crontick-mcp-config-'));
  writeTestConfig(home);
  transport = new StdioClientTransport({
    command: process.execPath, args: [MCP], stderr: 'pipe',
    env: { ...process.env, CRONTICK_HOME: home, CRONTICK_MCP_START_DAEMON: '0' },
  });
  client = new Client({ name: 'mcp-config-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
}, 15_000);
afterAll(async () => {
  try { await client?.close(); } catch { /* ignore */ }
  try { await transport?.close(); } catch { /* ignore */ }
  rmSync(home, { recursive: true, force: true });
});

describe('MCP config tools', () => {
  it('registers the four tools; set/unset expose inFlight', async () => {
    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const n of ['list', 'get', 'set', 'unset']) expect(byName.has(`crontick_config_${n}`)).toBe(true);
    for (const n of ['set', 'unset']) {
      const props = (byName.get(`crontick_config_${n}`)!.inputSchema as { properties: Json }).properties;
      expect(props.inFlight.enum).toEqual(['stop', 'wait']);
    }
    expect(byName.get('crontick_config_list')!.annotations?.readOnlyHint).toBe(true);
  });

  it('list returns the redacted effective config', async () => {
    const { json, isError } = await call('crontick_config_list', {});
    expect(isError).toBe(false);
    expect(json.config.daemon.port).toBe(0);
    expect(json.readOnly).toEqual(['daemon']);
  });

  it('get returns the typed value; unknown key is an error', async () => {
    expect((await call('crontick_config_get', { key: 'daemon.port' })).json).toEqual({ key: 'daemon.port', value: 0 });
    expect((await call('crontick_config_get', { key: 'nope.x' })).isError).toBe(true);
  });

  it('set takes typed JSON (no parsing) and returns reload, warnings, notice', async () => {
    const { json, isError } = await call('crontick_config_set', { key: 'defaults.timeoutSec', value: 90 });
    expect(isError).toBe(false);
    expect(stored().defaults.timeoutSec).toBe(90);
    expect(json.reload).toBe('daemon-not-running');
    expect(json.warnings).toEqual([]);
    expect(json.notice).toBe(CONFIG_EDIT_NOTICE);
    // a numeric-looking string stays a string
    const s = await call('crontick_config_set', { key: 'engines.n', value: { command: '123', type: 'raw' } });
    expect(s.isError).toBe(false);
    expect(stored().engines.n.command).toBe('123');
  });

  it('set with a wrong type errors without writing; unset reverts', async () => {
    expect((await call('crontick_config_set', { key: 'defaults.timeoutSec', value: 'abc' })).isError).toBe(true);
    expect(stored().defaults.timeoutSec).toBe(90);
    const u = await call('crontick_config_unset', { key: 'defaults.timeoutSec' });
    expect(u.isError).toBe(false);
    expect(stored().defaults?.timeoutSec).toBeUndefined();
    expect(u.json.notice).toBe(CONFIG_EDIT_NOTICE);
  });
});
