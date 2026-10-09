import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createClient } from '../../src/client.js';
import { writeTestConfig } from '../helpers/test-home.js';

const CLI = resolve('dist', 'cli', 'index.js');
const MCP = resolve('dist', 'mcp', 'index.js');
const SCRATCH_ROOT = resolve('.crontick', 'daemon-status-fields-ctd-012');

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
    catchUpRuns: number;
  };
};

type InfoPayload = {
  daemon: { running: boolean; pid?: number; port?: number };
  dashboardUrl: string | null;
  configPath: string;
};

type ToolCallJson = { error?: string; [key: string]: unknown };

let home = '';
let baseUrl = '';
let port = 0;
let mcpClient: Client;
let mcpTransport: StdioClientTransport;

function pidFile(): string {
  return join(home, 'daemon.pid');
}

function portFile(): string {
  return join(home, 'daemon.port');
}

function cli(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CRONTICK_HOME: home, ...env },
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
    const value = readNumber(portFile());
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
  try { cli(['daemon', 'stop'], baseUrl ? { CRONTICK_DAEMON_URL: baseUrl } : {}); } catch { /* ignore */ }
  const pid = readNumber(pidFile());
  if (pid === undefined) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  waitForPidExit(pid);
}

function resetHome(): void {
  if (!home) return;
  stopDaemon();
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, 'jobs'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
  writeTestConfig(home);
}

function removeHome(): void {
  if (!home) return;
  stopDaemon();
  rmSync(home, { recursive: true, force: true });
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

beforeEach(async () => {
  home = join(SCRATCH_ROOT, randomUUID());
  resetHome();
  const started = cli(['jobs', 'list']);
  if (started.status !== 0) {
    throw new Error(`daemon start failed (${started.status}): ${started.stderr}`);
  }

  port = waitForPort();
  baseUrl = `http://127.0.0.1:${port}`;

  mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP],
    env: {
      ...process.env,
      CRONTICK_HOME: home,
      CRONTICK_DAEMON_URL: baseUrl,
      CRONTICK_MCP_START_DAEMON: '0',
    },
    stderr: 'pipe',
  });
  mcpClient = new Client({ name: 'ctd-012-test-client', version: '0.0.0' }, { capabilities: {} });
  await mcpClient.connect(mcpTransport);
}, 20_000);

afterEach(async () => {
  try { await mcpClient?.close(); } catch { /* ignore */ }
  try { await mcpTransport?.close(); } catch { /* ignore */ }
  removeHome();
  home = '';
  baseUrl = '';
  port = 0;
});

describe('daemon status discovery fields', () => {
  it('surfaces daemon port and dashboard URL across library, CLI info, and MCP info', async () => {
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
        catchUpRuns: expect.any(Number),
      },
    });

    const textInfo = cli(['info'], { CRONTICK_DAEMON_URL: baseUrl });
    expect(textInfo.status, textInfo.stderr).toBe(0);
    expect(textInfo.stdout).toContain(`daemon     running (pid ${String(clientStatus.pid)}, port ${String(port)})`);
    expect(textInfo.stdout).toContain(`dashboard  ${baseUrl}/dashboard`);

    const infoPayload = await client.info() as InfoPayload;
    expect(infoPayload).toMatchObject({
      daemon: { running: true, pid: clientStatus.pid, port },
      dashboardUrl: `${baseUrl}/dashboard`,
      configPath: expect.any(String),
    });

    const { json: mcpJson, isError } = await callTool('crontick_info', {});
    expect(isError).toBe(false);
    expect(mcpJson).toMatchObject({
      daemon: { running: true, pid: clientStatus.pid, port },
      dashboardUrl: `${baseUrl}/dashboard`,
      configPath: expect.any(String),
    });
  }, 20_000);
});
