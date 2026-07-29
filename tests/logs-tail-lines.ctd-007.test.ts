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
const INTERLEAVED_RUN_ID = 'ctd-007-interleaved-run';
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
const INTERLEAVED_PARTIAL_LOGS = [
  {
    runId: INTERLEAVED_RUN_ID,
    stream: 'stdout',
    ts: 1,
    data: 'stdout-without-newline',
  },
  {
    runId: INTERLEAVED_RUN_ID,
    stream: 'stderr',
    ts: 2,
    data: 'stderr-line-1\n',
  },
  {
    runId: INTERLEAVED_RUN_ID,
    stream: 'stderr',
    ts: 3,
    data: 'stderr-final-without-newline',
  },
] as const;
const EXPECTED_TAIL = ['line-8\n', 'line-9\n', 'line-10\n'];
const EXPECTED_INTERLEAVED_LINES = ['stdout-without-newline', 'stderr-line-1\n', 'stderr-final-without-newline'];
const LOGS_BY_RUN_ID = new Map<string, readonly { runId: string; stream: string; ts: number; data: string }[]>([
  [RUN_ID, CHUNKED_LOGS],
  [INTERLEAVED_RUN_ID, INTERLEAVED_PARTIAL_LOGS],
]);

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

async function expectTailAcrossClientCliAndMcp(runId: string, lines: number, expected: string[]): Promise<void> {
  const client = createClient({ daemonUrl: baseUrl, startDaemon: false });
  const clientTail = await client.getLogs(runId, { lines });
  expect(clientTail.runId).toBe(runId);
  expect(clientTail.lines.map((line) => line.data)).toEqual(expected);

  const cliResult = await cli(['logs', runId, '--tail', String(lines)]);
  expect(cliResult.status, cliResult.stderr).toBe(0);
  const cliJson = JSON.parse(cliResult.stdout) as { runId: string; lines: Array<{ data: string }> };
  expect(cliJson.runId).toBe(runId);
  expect(cliJson.lines.map((line) => line.data)).toEqual(expected);

  const { json: mcpJson, isError } = await callTool('crontick_run_logs_tail', { id: runId, lines });
  expect(isError).toBe(false);
  expect((mcpJson as { runId: string }).runId).toBe(runId);
  expect((mcpJson as { lines: Array<{ data: string }> }).lines.map((line) => line.data)).toEqual(expected);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, product: 'crontick', pid: process.pid, port });
    }

    const logsMatch = req.method === 'GET' ? url.pathname.match(/^\/api\/runs\/([^/]+)\/logs$/) : null;
    if (logsMatch) {
      const logs = LOGS_BY_RUN_ID.get(logsMatch[1]);
      if (logs) return json(res, 200, logs);
    }

    const runMatch = req.method === 'GET' ? url.pathname.match(/^\/api\/runs\/([^/]+)$/) : null;
    if (runMatch && LOGS_BY_RUN_ID.has(runMatch[1])) {
      return json(res, 200, { id: runMatch[1], status: 'success' });
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

    await expectTailAcrossClientCliAndMcp(RUN_ID, 3, EXPECTED_TAIL);
  });

  it('preserves interleaved stdout/stderr partial-line order and keeps the final partial exactly once', async () => {
    const client = createClient({ daemonUrl: baseUrl, startDaemon: false });

    const allClientLogs = await client.getLogs(INTERLEAVED_RUN_ID);
    expect(allClientLogs.runId).toBe(INTERLEAVED_RUN_ID);
    expect(allClientLogs.lines.map((line) => line.data)).toEqual(EXPECTED_INTERLEAVED_LINES);
    expect(allClientLogs.lines.filter((line) => line.data === 'stderr-final-without-newline')).toHaveLength(1);

    await expectTailAcrossClientCliAndMcp(INTERLEAVED_RUN_ID, 3, EXPECTED_INTERLEAVED_LINES);
  });
});
