import http from 'node:http';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCP_TOOLS } from '../src/surface.js';

const MCP = resolve('dist', 'mcp', 'index.js');
const RUN_ID = 'ctd-015-run';
const OTHER_RUN_ID = 'ctd-015-other-run';
const LOG_LINES = [
  { runId: RUN_ID, stream: 'stdout', ts: 1, data: 'line-1\n' },
  { runId: RUN_ID, stream: 'stdout', ts: 2, data: 'line-2\n' },
] as const;
const EXPECTED_TOOL_PARAMS = {
  crontick_job_create: ['id', 'description', 'enabled', 'schedule', 'action', 'overlap', 'retry', 'force'],
  crontick_job_list: [],
  crontick_job_get: ['id'],
  crontick_job_update: ['id', 'description', 'enabled', 'schedule', 'action', 'overlap', 'retry'],
  crontick_job_delete: ['id'],
  crontick_job_enable: ['id'],
  crontick_job_disable: ['id'],
  crontick_job_run_now: ['id'],
  crontick_job_cancel_run: ['id', 'runId'],
  crontick_run_list: ['jobId', 'limit', 'since', 'status'],
  crontick_run_get: ['id', 'runId'],
  crontick_run_logs_tail: ['id', 'runId', 'lines'],
  crontick_schedule_validate: ['schedule'],
  crontick_schedule_preview: ['schedule', 'n', 'tz'],
  crontick_stats_summary: [],
  crontick_stats_job: ['id'],
  crontick_daemon_start: [],
  crontick_daemon_stop: [],
  crontick_daemon_status: [],
  crontick_daemon_reload: [],
  crontick_daemon_restart: [],
  crontick_export: ['includeRuns'],
  crontick_import: ['jobs', 'runs'],
  crontick_dashboard_start: [],
  crontick_dashboard_status: [],
  crontick_dashboard_data: ['jobId', 'runsLimit'],
  crontick_dashboard_stop: [],
  crontick_doctor: [],
  crontick_config_get: ['path'],
  crontick_config_set: ['path', 'value'],
  crontick_config_unset: ['path'],
  crontick_config_engine_list: [],
  crontick_config_engine_add: ['name', 'engine'],
  crontick_config_engine_update: ['name', 'engine'],
  crontick_config_engine_remove: ['name'],
  crontick_config_init: ['force'],
  crontick_config_validate: ['path'],
} as const;

type ToolCallJson = { error?: string; [key: string]: unknown };
type ListedTool = { name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } };

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
  return {
    json: JSON.parse(text) as ToolCallJson,
    isError: result.isError === true,
  };
}

function topLevelParams(tool: ListedTool): string[] {
  return Object.keys(tool.inputSchema?.properties ?? {}).filter((name) => name !== 'verbose');
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
    if (req.method === 'GET' && url.pathname === `/api/runs/${RUN_ID}/logs`) {
      return json(res, 200, LOG_LINES);
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

describe('CTD-015 MCP parameter naming', () => {
  it('keeps tool names stable and matches the full audited parameter inventory', async () => {
    const listed = await mcpClient.listTools();
    const tools = listed.tools.filter((tool) => tool.name.startsWith('crontick_')) as ListedTool[];
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOLS].sort());
    expect(tools).toHaveLength(37);

    for (const [name, expectedParams] of Object.entries(EXPECTED_TOOL_PARAMS)) {
      const tool = byName.get(name);
      expect(tool, `missing tool metadata for ${name}`).toBeDefined();
      expect(topLevelParams(tool!).sort(), `${name} params drifted`).toEqual([...expectedParams].sort());
    }

    for (const name of ['crontick_job_cancel_run', 'crontick_run_get', 'crontick_run_logs_tail']) {
      const params = topLevelParams(byName.get(name)!);
      expect(params.indexOf('id'), `${name} should expose id`).toBeGreaterThanOrEqual(0);
      expect(params.indexOf('runId'), `${name} should retain runId alias`).toBeGreaterThan(params.indexOf('id'));
      expect(byName.get(name)?.description ?? '', `${name} should document the deprecation`).toMatch(/deprecated alias/i);
    }
  });

  it('accepts id, keeps runId as an alias, and prefers id when both are supplied', async () => {
    const cases = [
      {
        name: 'crontick_run_get',
        withId: { id: RUN_ID },
        withAlias: { runId: RUN_ID },
        withBoth: { id: RUN_ID, runId: OTHER_RUN_ID },
      },
      {
        name: 'crontick_run_logs_tail',
        withId: { id: RUN_ID, lines: 2 },
        withAlias: { runId: RUN_ID, lines: 2 },
        withBoth: { id: RUN_ID, runId: OTHER_RUN_ID, lines: 2 },
      },
      {
        name: 'crontick_job_cancel_run',
        withId: { id: RUN_ID },
        withAlias: { runId: RUN_ID },
        withBoth: { id: RUN_ID, runId: OTHER_RUN_ID },
      },
    ] as const;

    for (const testCase of cases) {
      const preferred = await callTool(testCase.name, testCase.withId);
      expect(preferred.isError, `${testCase.name} should accept id`).toBe(false);

      const alias = await callTool(testCase.name, testCase.withAlias);
      expect(alias.isError, `${testCase.name} should accept runId`).toBe(false);
      expect(alias.json).toEqual(preferred.json);

      const both = await callTool(testCase.name, testCase.withBoth);
      expect(both.isError, `${testCase.name} should prefer id when both identifiers are supplied`).toBe(false);
      expect(both.json).toEqual(preferred.json);
    }
  });

  it('rejects missing identifiers with clear guidance', async () => {
    const cases = [
      { name: 'crontick_run_get', args: {} },
      { name: 'crontick_run_logs_tail', args: { lines: 1 } },
      { name: 'crontick_job_cancel_run', args: {} },
    ] as const;

    for (const testCase of cases) {
      const result = await callTool(testCase.name, testCase.args);
      expect(result.isError, `${testCase.name} should reject a missing identifier`).toBe(true);
      expect(result.json.error ?? '').toContain('provide id');
      expect(result.json.error ?? '').toContain('runId');
    }
  });
});
