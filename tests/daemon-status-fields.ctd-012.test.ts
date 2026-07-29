import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createClient } from '../src/client.js';

const CLI = resolve('dist', 'cli', 'index.js');
const MCP = resolve('dist', 'mcp', 'index.js');
const HOME = String.raw`Q:\Rough\crontick-qa\state\devfix2\daemon-status-fields-ctd-012`;
const PID_FILE = join(HOME, 'daemon.pid');
const PORT_FILE = join(HOME, 'daemon.port');

type StatusPayload = {
  pid: number;
  version: string;
  port: number;
  baseUrl: string;
  uptimeSec: number;
  jobs: number;
  missedFires: {
    jobsWithMissedFires: number;
    missedRunsRecorded: number;
    jobsCapped: number;
    capPerJob: number;
  };
};

type ToolCallJson = { error?: string; [key: string]: unknown };

let baseUrl = '';
let port = 0;
let mcpClient: Client;
let mcpTransport: StdioClientTransport;

function cli(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CRONTICK_HOME: HOME, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readNumber(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const value = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function waitForPort(maxMs = 15_000): number {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const value = readNumber(PORT_FILE);
    if (value !== undefined) return value;
    sleep(50);
  }
  throw new Error('Timed out waiting for daemon.port');
}

function waitForPidExit(pid: number, maxMs = 5_000): void {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      sleep(50);
    } catch {
      return;
    }
  }
}

function stopDaemon(): void {
  try { cli(['--json', 'daemon', 'stop'], baseUrl ? { CRONTICK_DAEMON_URL: baseUrl } : {}); } catch { /* ignore */ }
  const pid = readNumber(PID_FILE);
  if (pid === undefined) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  waitForPidExit(pid);
}

function resetHome(): void {
  stopDaemon();
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(HOME, 'jobs'), { recursive: true });
  mkdirSync(join(HOME, 'logs'), { recursive: true });
}

function removeHome(): void {
  stopDaemon();
  rmSync(HOME, { recursive: true, force: true });
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

beforeAll(async () => {
  resetHome();
  const started = cli(['--json', 'daemon', 'start']);
  if (started.status !== 0) {
    throw new Error(`daemon start failed (${started.status}): ${started.stderr}`);
  }

  const payload = JSON.parse(started.stdout) as { baseUrl?: string; port?: number };
  port = payload.port ?? waitForPort();
  baseUrl = payload.baseUrl ?? `http://127.0.0.1:${port}`;

  mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP],
    env: {
      ...process.env,
      CRONTICK_HOME: HOME,
      CRONTICK_DAEMON_URL: baseUrl,
      CRONTICK_MCP_START_DAEMON: '0',
    },
    stderr: 'pipe',
  });
  mcpClient = new Client({ name: 'ctd-012-test-client', version: '0.0.0' }, { capabilities: {} });
  await mcpClient.connect(mcpTransport);
}, 20_000);

afterAll(async () => {
  try { await mcpClient?.close(); } catch { /* ignore */ }
  try { await mcpTransport?.close(); } catch { /* ignore */ }
  removeHome();
});

describe('CTD-012 daemon status discovery fields', () => {
  it('surfaces port and baseUrl across client, CLI text/json, and MCP', async () => {
    const client = createClient({ daemonUrl: baseUrl, startDaemon: false });
    const clientStatus = await client.daemonStatus() as StatusPayload;

    expect(clientStatus).toMatchObject({
      pid: expect.any(Number),
      version: expect.any(String),
      port,
      baseUrl,
      uptimeSec: expect.any(Number),
      jobs: expect.any(Number),
      missedFires: {
        jobsWithMissedFires: expect.any(Number),
        missedRunsRecorded: expect.any(Number),
        jobsCapped: expect.any(Number),
        capPerJob: expect.any(Number),
      },
    });

    const textStatus = cli(['daemon', 'status'], { CRONTICK_DAEMON_URL: baseUrl });
    expect(textStatus.status, textStatus.stderr).toBe(0);
    expect(textStatus.stdout).toContain(`port: ${String(port)}`);
    expect(textStatus.stdout).toContain(`baseUrl: ${baseUrl}`);

    const jsonStatus = cli(['--json', 'daemon', 'status'], { CRONTICK_DAEMON_URL: baseUrl });
    expect(jsonStatus.status, jsonStatus.stderr).toBe(0);
    expect(JSON.parse(jsonStatus.stdout)).toMatchObject({ port, baseUrl });

    const { json: mcpJson, isError } = await callTool('crontick_daemon_status', {});
    expect(isError).toBe(false);
    expect(mcpJson).toMatchObject({
      pid: clientStatus.pid,
      version: clientStatus.version,
      port,
      baseUrl,
      missedFires: clientStatus.missedFires,
    });
  }, 20_000);
});
