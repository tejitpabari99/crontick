import http from 'node:http';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCP_TOOLS } from '../../src/surface.js';

const MCP = resolve('dist', 'mcp', 'index.js');
const RUN_ID = 'ctd-015-run';
const EXPECTED_TOOL_PARAMS = {
  crontick_job_create: ['id', 'alias', 'description', 'enabled', 'schedule', 'action', 'overlap', 'retry', 'force', 'trustFolder'],
  crontick_job_list: [],
  crontick_job_get: ['id'],
  crontick_job_update: ['id', 'alias', 'description', 'enabled', 'schedule', 'action', 'overlap', 'retry', 'trustFolder'],
  crontick_job_delete: ['id', 'all', 'force'],
  crontick_job_enable: ['id'],
  crontick_job_disable: ['id'],
  crontick_job_run_now: ['id'],
  crontick_job_schedule: ['id', 'n'],
  crontick_job_cancel_run: ['id'],
  crontick_run_list: ['jobId', 'limit', 'since', 'status'],
  crontick_run_get: ['id'],
  crontick_run_delete: ['runIds', 'job', 'dryRun'],
  crontick_stats_summary: [],
  crontick_stats_job: ['id'],
  crontick_daemon_stop: [],
  crontick_daemon_reload: [],
  crontick_daemon_pause: [],
  crontick_daemon_resume: [],
  crontick_export: ['onlyJobs'],
  crontick_import: ['schema', 'jobs', 'exportedAt', 'crontickVersion', 'trustFolder'],
  crontick_config_list: [],
  crontick_config_get: ['key'],
  crontick_config_set: ['key', 'value', 'inFlight'],
  crontick_config_unset: ['key', 'inFlight'],
  crontick_doctor: [],
  crontick_info: [],
  crontick_autostart_status: [],
} as const;

type ToolCallJson = { error?: string; [key: string]: unknown };
type ListedTool = {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{
      properties?: Record<string, unknown>;
      required?: string[];
    }>;
  };
};

let server: http.Server;
let mcpClient: Client;
let mcpTransport: StdioClientTransport;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ json: ToolCallJson; isError: boolean }> {
  const raw = await mcpClient.callTool({ name, arguments: args });
  const result = raw as { content: Array<{ text?: string }>; isError?: boolean };
  const text = result.content[0]?.text ?? '{}';
  let json: ToolCallJson;
  try {
    json = JSON.parse(text) as ToolCallJson;
  } catch {
    json = { error: text };
  }
  return {
    json,
    isError: result.isError === true,
  };
}

function topLevelParams(tool: ListedTool): string[] {
  const direct = Object.keys(tool.inputSchema?.properties ?? {}).filter((name) => name !== 'verbose');
  if (direct.length > 0) return direct;

  const merged = new Set<string>();
  for (const variant of tool.inputSchema?.anyOf ?? []) {
    for (const name of Object.keys(variant.properties ?? {})) {
      if (name !== 'verbose') merged.add(name);
    }
  }
  return [...merged];
}

function requiredParams(tool: ListedTool): string[] {
  return (tool.inputSchema?.required ?? []).filter((name) => name !== 'verbose');
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, product: 'crontick', pid: process.pid, port });
    }
    if (req.method === 'GET' && url.pathname === `/api/runs/${RUN_ID}`) {
      return json(res, 200, { id: RUN_ID, status: 'success', outputTruncated: false });
    }
    if (req.method === 'GET' && url.pathname === `/api/runs/${RUN_ID}/output`) {
      return json(res, 200, { runId: RUN_ID, status: 'success', format: 'text', result: null, error: null, output: '', stderr: '' });
    }
    if (req.method === 'POST' && url.pathname === `/api/runs/${RUN_ID}/cancel`) {
      return json(res, 200, { ok: true, canceled: true });
    }
    return json(res, 404, { error: { code: 'NOT_FOUND', message: `missing ${url.pathname}` } });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP],
    env: {
      ...process.env,
      CRONTICK_DAEMON_URL: baseUrl,
      CRONTICK_MCP_START_DAEMON: '0',
      CRONTICK_HOME: resolve('.crontick', 'mcp-tool-params-ctd-015'),
    },
    stderr: 'pipe',
  });
  mcpClient = new Client({ name: 'ctd-015-test-client', version: '0.0.0' }, { capabilities: {} });
  await mcpClient.connect(mcpTransport);
}, 15_000);

afterAll(async () => {
  try { await mcpClient?.close(); } catch { /* ignore */ }
  try { await mcpTransport?.close(); } catch { /* ignore */ }
  await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
});

describe('MCP parameter naming', () => {
  it('keeps tool names stable, exposes the full parameter inventory, and advertises single-run requiredness', async () => {
    const listed = await mcpClient.listTools();
    const tools = listed.tools.filter((tool) => tool.name.startsWith('crontick_')) as ListedTool[];
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOLS].sort());
    expect(tools).toHaveLength(28);

    for (const [name, expectedParams] of Object.entries(EXPECTED_TOOL_PARAMS)) {
      const tool = byName.get(name);
      expect(tool, `missing tool metadata for ${name}`).toBeDefined();
      expect(topLevelParams(tool!).sort(), `${name} params drifted`).toEqual([...expectedParams].sort());
    }

    for (const name of ['crontick_job_cancel_run', 'crontick_run_get']) {
      const tool = byName.get(name)!;
      const params = topLevelParams(tool);
      expect(params, `${name} should expose id`).toContain('id');
      expect(params, `${name} should not expose a runId alias`).not.toContain('runId');
      expect(requiredParams(tool), `${name} should require id`).toContain('id');
    }
  });

  it('accepts id as the only single-run identifier', async () => {
    const cases = [
      { name: 'crontick_run_get', args: { id: RUN_ID } },
      { name: 'crontick_job_cancel_run', args: { id: RUN_ID } },
    ] as const;

    for (const testCase of cases) {
      const result = await callTool(testCase.name, testCase.args);
      expect(result.isError, `${testCase.name} should accept id`).toBe(false);
    }
  });

  it('rejects a missing id and does not accept runId', async () => {
    const cases = [
      { name: 'crontick_run_get', args: {}, label: 'missing id' },
      { name: 'crontick_run_get', args: { runId: RUN_ID }, label: 'runId only' },
      { name: 'crontick_job_cancel_run', args: {}, label: 'missing id' },
      { name: 'crontick_job_cancel_run', args: { runId: RUN_ID }, label: 'runId only' },
    ] as const;

    for (const testCase of cases) {
      const result = await callTool(testCase.name, testCase.args);
      expect(result.isError, `${testCase.name} should reject ${testCase.label}`).toBe(true);
      expect(String(result.json.error ?? ''), `${testCase.name} should mention id`).toContain('id');
    }
  });
});
