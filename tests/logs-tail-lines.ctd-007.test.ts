import http from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createClient } from '../src/client.js';

const CLI = resolve('dist', 'cli', 'index.js');
const MCP = resolve('dist', 'mcp', 'index.js');
const RUN_ID = 'ctd-007-run';
const CHUNKED_LOGS = [
  {
    runId: RUN_ID,
    stream: 'stdout',
    ts: 1,
    data: 'line-1\nline-2\nline-3\nline-4\nline-5\nline-6\nline-7\nli',
  },
  {
    runId: RUN_ID,
    stream: 'stdout',
    ts: 2,
    data: 'ne-8\nline-9\nline-10\n',
  },
] as const;
const EXPECTED_TAIL = ['line-8\n', 'line-9\n', 'line-10\n'];

let server: http.Server;
let baseUrl: string;
let mcpClient: Client;
let mcpTransport: StdioClientTransport;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function cli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveCli, rejectCli) => {
    const child = spawn(process.execPath, [CLI, '--json', ...args], {
      env: {
        ...process.env,
        CRONTICK_DAEMON_URL: baseUrl,
        CRONTICK_HOME: resolve('.crontick', 'logs-tail-lines-ctd-007-cli'),
      },
      stdio: 'pipe',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', rejectCli);
    child.on('close', (status) => {
      resolveCli({ status, stdout, stderr });
    });
  });
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ json: unknown; isError: boolean }> {
  const raw = await mcpClient.callTool({ name, arguments: args });
  const result = raw as { content: Array<{ text?: string }>; isError?: boolean };
  const text = result.content[0]?.text ?? '';
  return {
    json: JSON.parse(text),
    isError: result.isError === true,
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, product: 'crontick', pid: process.pid, port });
    }
    if (req.method === 'GET' && url.pathname === `/api/runs/${RUN_ID}/logs`) {
      return json(res, 200, CHUNKED_LOGS);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/runs/')) {
      return json(res, 200, { id: RUN_ID, status: 'success' });
    }
    return json(res, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP],
    env: {
      ...process.env,
      CRONTICK_DAEMON_URL: baseUrl,
      CRONTICK_HOME: resolve('.crontick', 'logs-tail-lines-ctd-007-mcp'),
    },
    stderr: 'pipe',
  });
  mcpClient = new Client({ name: 'ctd-007-test-client', version: '0.0.0' }, { capabilities: {} });
  await mcpClient.connect(mcpTransport);
}, 15_000);

afterAll(async () => {
  try { await mcpClient?.close(); } catch { /* ignore */ }
  try { await mcpTransport?.close(); } catch { /* ignore */ }
  await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
});

describe('CTD-007 log tailing', () => {
  it('reconstructs logical lines before tailing across client, CLI, and MCP', async () => {
    const client = createClient({ daemonUrl: baseUrl, startDaemon: false });

    const allClientLogs = await client.getLogs(RUN_ID);
    expect(allClientLogs.runId).toBe(RUN_ID);
    expect(allClientLogs.lines.map((line) => line.data)).toEqual([
      'line-1\n',
      'line-2\n',
      'line-3\n',
      'line-4\n',
      'line-5\n',
      'line-6\n',
      'line-7\n',
      'line-8\n',
      'line-9\n',
      'line-10\n',
    ]);

    const clientTail = await client.getLogs(RUN_ID, { lines: 3 });
    expect(clientTail.lines.map((line) => line.data)).toEqual(EXPECTED_TAIL);

    const cliResult = await cli(['logs', RUN_ID, '--tail', '3']);
    expect(cliResult.status, cliResult.stderr).toBe(0);
    const cliJson = JSON.parse(cliResult.stdout) as { runId: string; lines: Array<{ data: string }> };
    expect(cliJson.runId).toBe(RUN_ID);
    expect(cliJson.lines.map((line) => line.data)).toEqual(EXPECTED_TAIL);

    const { json: mcpJson, isError } = await callTool('crontick_run_logs_tail', { runId: RUN_ID, lines: 3 });
    expect(isError).toBe(false);
    expect((mcpJson as { runId: string }).runId).toBe(RUN_ID);
    expect((mcpJson as { lines: Array<{ data: string }> }).lines.map((line) => line.data)).toEqual(EXPECTED_TAIL);
  });
});
