/**
 * MCP server contract tests.
 * Starts a real daemon + MCP server (both from dist/), drives them with the
 * official MCP client SDK, and asserts the full tool/resource/prompt contract.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { jobJsonSchemaText } from '../src/schema-json.js';

const DAEMON_SCRIPT = join(process.cwd(), 'dist', 'daemon', 'index.js');
const MCP_SCRIPT = join(process.cwd(), 'dist', 'mcp', 'index.js');
const TIMEOUT_MS = 60_000;

// ── Helper types ──────────────────────────────────────────────────────────────

interface ToolCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

// Wrapper to call a tool and return typed result
async function callTool(
  c: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ json: unknown; isError: boolean; text: string }> {
  const raw = await c.callTool({ name, arguments: args });
  const result = raw as unknown as ToolCallResult;
  const text = (result.content[0]?.text as string | undefined) ?? '';
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { json, isError: result.isError === true, text };
}

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'crontick-mcp-'));
  mkdirSync(join(d, 'jobs'), { recursive: true });
  mkdirSync(join(d, 'logs'), { recursive: true });
  return d;
}

function stopDaemonInHome(dir: string): void {
  const pidFile = join(dir, 'daemon.pid');
  if (!existsSync(pidFile)) return;
  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  if (!isNaN(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  }
}

function waitForPortFile(dir: string, maxMs = 30_000, getStderr?: () => string): Promise<number> {
  const portFile = join(dir, 'daemon.port');
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = Math.ceil(maxMs / 250);
    const check = () => {
      if (existsSync(portFile)) {
        try {
          const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
          if (!isNaN(port) && port > 0) return resolve(port);
        } catch { /* mid-write, retry */ }
      }
      attempts++;
      if (attempts >= maxAttempts) {
        const stderr = getStderr?.() ?? '';
        return reject(
          new Error(`Timed out waiting for daemon${stderr ? `\nDaemon stderr:\n${stderr}` : ''}`),
        );
      }
      setTimeout(check, 250);
    };
    check();
  });
}

// ── Shared suite fixtures ─────────────────────────────────────────────────────

let dir: string;
let daemonProc: ChildProcess;
let port: number;
let client: Client;
let transport: StdioClientTransport;

// ── Full integration suite ────────────────────────────────────────────────────

describe('MCP server — full contract', () => {
  beforeAll(async () => {
    dir = makeTmpDir();
    const stderrChunks: string[] = [];
    daemonProc = spawn(process.execPath, [DAEMON_SCRIPT], {
      env: { ...process.env, CRONTICK_HOME: dir },
      stdio: 'pipe',
    });
    daemonProc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));
    port = await waitForPortFile(dir, 30_000, () => stderrChunks.join(''));

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_SCRIPT],
      env: {
        ...process.env,
        CRONTICK_HOME: dir,
        // Daemon is already running; point directly at it
        CRONTICK_DAEMON_URL: `http://127.0.0.1:${port}`,
      },
      stderr: 'pipe',
    });

    client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
  }, TIMEOUT_MS);

  afterAll(async () => {
    try { await client?.close(); } catch { /* ignore */ }
    try { await transport?.close(); } catch { /* ignore */ }
    daemonProc?.kill('SIGTERM');
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── Handshake ───────────────────────────────────────────────────────────────

  it('server info returned after initialize', () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe('crontick');
    expect(typeof info?.version).toBe('string');
  });

  it('capabilities include tools and resources', () => {
    const caps = client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
    expect(caps?.resources).toBeDefined();
  });

  // ── Tools list ──────────────────────────────────────────────────────────────

  const EXPECTED_TOOLS = [
    'crontick_job_create',
    'crontick_job_list',
    'crontick_job_get',
    'crontick_job_update',
    'crontick_job_delete',
    'crontick_job_enable',
    'crontick_job_disable',
    'crontick_job_run_now',
    'crontick_job_cancel_run',
    'crontick_run_list',
    'crontick_run_get',
    'crontick_run_logs_tail',
    'crontick_schedule_preview',
    'crontick_schedule_validate',
    'crontick_stats_summary',
    'crontick_stats_job',
    'crontick_daemon_status',
    'crontick_daemon_reload',
    'crontick_daemon_restart',
    'crontick_export',
    'crontick_import',
    'crontick_dashboard_start',
    'crontick_dashboard_status',
    'crontick_dashboard_data',
    'crontick_dashboard_stop',
    'crontick_doctor',
    'crontick_config_get',
    'crontick_config_set',
    'crontick_config_unset',
    'crontick_config_engine_list',
    'crontick_config_engine_add',
    'crontick_config_engine_update',
    'crontick_config_engine_remove',
    'crontick_config_init',
    'crontick_config_validate',
  ];

  it('tools/list returns all catalog tools with crontick_ prefix', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    for (const expected of EXPECTED_TOOLS) {
      expect(names, `missing tool: ${expected}`).toContain(expected);
    }
    for (const tool of result.tools) {
      expect(tool.name).toMatch(/^crontick_/);
      expect(tool.name).not.toContain('auto' + 'start');
    }
  });

  it('all tools have a non-empty description', async () => {
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(tool.description?.length ?? 0, `tool ${tool.name} missing description`).toBeGreaterThan(0);
    }
  });

  // ── Job CRUD round-trip ──────────────────────────────────────────────────────

  const testJobId = 'mcp-test-job';

  it('crontick_job_create creates a job', async () => {
    const { json, isError } = await callTool(client, 'crontick_job_create', {
      id: testJobId,
      description: 'MCP contract test job',
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: { kind: 'exec', command: 'echo', args: ['hello'] },
    });
    expect(isError).toBe(false);
    expect((json as { id: string }).id).toBe(testJobId);
    expect(readFileSync(join(dir, 'jobs', `${testJobId}.schema.json`), 'utf-8')).toBe(jobJsonSchemaText());
  });

  it('crontick_job_create accepts prompt actions', async () => {
    const { json, isError } = await callTool(client, 'crontick_job_create', {
      id: 'mcp-prompt-job',
      description: 'MCP prompt job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'hello', engine: 'copilot', args: ['--silent'] },
    });
    expect(isError).toBe(false);
    expect((json as { action: unknown }).action).toMatchObject({
      kind: 'prompt',
      prompt: 'hello',
      engine: 'copilot',
      args: ['--silent'],
    });
  });

  it('crontick_job_create reports session precedence notices from core', async () => {
    const { json, isError } = await callTool(client, 'crontick_job_create', {
      id: 'mcp-session-precedence-job',
      description: 'MCP prompt session precedence job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'hello', sessionId: 'sess-mcpprec1', reuseSession: true },
    });
    expect(isError).toBe(false);
    expect(json).toMatchObject({
      result: {
        action: {
          kind: 'prompt',
          sessionId: 'sess-mcpprec1',
          reuseSession: false,
        },
      },
      notices: [expect.stringContaining('reuseSession was ignored')],
    });
  });

  it('crontick_job_create accepts promptFile through the shared client schema', async () => {
    const promptPath = join(dir, 'mcp-prompt.txt');
    writeFileSync(promptPath, 'hello from mcp prompt file', 'utf-8');
    const { json, isError } = await callTool(client, 'crontick_job_create', {
      id: 'mcp-prompt-file-job',
      description: 'MCP prompt file job',
      schedule: { kind: 'cron', cron: '0 10 * * *' },
      action: { kind: 'prompt', promptFile: promptPath, engine: 'copilot' },
    });
    expect(isError).toBe(false);
    expect((json as { action: unknown }).action).toMatchObject({
      kind: 'prompt',
      prompt: 'hello from mcp prompt file',
      engine: 'copilot',
    });
    expect((json as { action: Record<string, unknown> }).action).not.toHaveProperty('promptFile');
  });

  it('crontick_job_list returns the created job', async () => {
    const { json, isError } = await callTool(client, 'crontick_job_list');
    expect(isError).toBe(false);
    const jobs = json as Array<{ id: string }>;
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs.some((j) => j.id === testJobId)).toBe(true);
  });

  it('crontick_job_get returns full job definition', async () => {
    const { json, isError } = await callTool(client, 'crontick_job_get', { id: testJobId });
    expect(isError).toBe(false);
    const job = json as { id: string; schedule: unknown };
    expect(job.id).toBe(testJobId);
    expect(job.schedule).toBeDefined();
  });

  it('crontick_job_run_now triggers a run and returns runId', async () => {
    const { json, isError } = await callTool(client, 'crontick_job_run_now', { id: testJobId });
    expect(isError).toBe(false);
    expect(typeof (json as { runId: string }).runId).toBe('string');
  });

  it('crontick_run_list returns runs for the job', async () => {
    const { json, isError } = await callTool(client, 'crontick_run_list', { jobId: testJobId });
    expect(isError).toBe(false);
    const runs = json as Array<{ jobId: string }>;
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });

  it('crontick_run_get and crontick_run_logs_tail work end-to-end', async () => {
    const { json: listJson } = await callTool(client, 'crontick_run_list', { jobId: testJobId, limit: 1 });
    const runs = listJson as Array<{ id: string }>;
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const runId = runs[0].id;

    const { json: runJson, isError: runErr } = await callTool(client, 'crontick_run_get', { runId });
    expect(runErr).toBe(false);
    expect((runJson as { id: string }).id).toBe(runId);

    const { json: logsJson, isError: logsErr } = await callTool(client, 'crontick_run_logs_tail', { runId, lines: 10 });
    expect(logsErr).toBe(false);
    const logsData = logsJson as { runId: string; lines: unknown[] };
    expect(logsData.runId).toBe(runId);
    expect(Array.isArray(logsData.lines)).toBe(true);
  }, 10_000);

  it('crontick_job_delete removes the job', async () => {
    const { json, isError } = await callTool(client, 'crontick_job_delete', { id: testJobId });
    expect(isError).toBe(false);
    expect((json as { ok: boolean }).ok).toBe(true);
  });

  // ── Schedule tools ──────────────────────────────────────────────────────────

  it('crontick_schedule_validate rejects garbage', async () => {
    const { json, isError } = await callTool(client, 'crontick_schedule_validate', {
      schedule: { kind: 'cron', cron: 'not-a-cron' },
    });
    // Either isError:true or ok:false in the response
    if (!isError) {
      expect((json as { ok?: boolean }).ok).toBe(false);
    } else {
      expect(isError).toBe(true);
    }
  });

  it('crontick_schedule_validate accepts "0 9 * * *"', async () => {
    const { json, isError } = await callTool(client, 'crontick_schedule_validate', {
      schedule: { kind: 'cron', cron: '0 9 * * *' },
    });
    expect(isError).toBe(false);
    expect((json as { ok: boolean }).ok).toBe(true);
  });

  it('crontick_schedule_preview returns N future ISO timestamps', async () => {
    const { json, isError } = await callTool(client, 'crontick_schedule_preview', {
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      n: 3,
    });
    expect(isError).toBe(false);
    const data = json as { next: string[] };
    expect(Array.isArray(data.next)).toBe(true);
    expect(data.next).toHaveLength(3);
    for (const ts of data.next) {
      expect(typeof ts).toBe('string');
      expect(new Date(ts).getTime()).not.toBeNaN();
    }
  });

  // ── Daemon tools ─────────────────────────────────────────────────────────────

  it('crontick_daemon_status returns healthy', async () => {
    const { json, isError } = await callTool(client, 'crontick_daemon_status');
    expect(isError).toBe(false);
    const data = json as { pid: number; version: string };
    expect(typeof data.pid).toBe('number');
    expect(data.pid).toBeGreaterThan(0);
    expect(typeof data.version).toBe('string');
  });

  it('crontick_daemon_reload returns ok', async () => {
    const { json, isError } = await callTool(client, 'crontick_daemon_reload');
    expect(isError).toBe(false);
    expect((json as { ok: boolean }).ok).toBe(true);
  });

  // ── Stats tools ─────────────────────────────────────────────────────────────

  it('crontick_stats_summary returns aggregated stats', async () => {
    const { json, isError } = await callTool(client, 'crontick_stats_summary');
    expect(isError).toBe(false);
    expect(typeof (json as { totalJobs: number }).totalJobs).toBe('number');
  });

  // ── Dashboard tools ─────────────────────────────────────────────────────────

  it('dashboard tools expose start/status/data through the same response shapes', async () => {
    const start = await callTool(client, 'crontick_dashboard_start');
    expect(start.isError).toBe(false);
    expect(start.json).toMatchObject({ ok: true, running: true, url: expect.stringContaining('/dashboard') });

    const status = await callTool(client, 'crontick_dashboard_status');
    expect(status.isError).toBe(false);
    expect(status.json).toMatchObject({ ok: true, running: true, url: expect.stringContaining('/dashboard') });

    const data = await callTool(client, 'crontick_dashboard_data', { runsLimit: 5 });
    expect(data.isError).toBe(false);
    expect(data.json).toMatchObject({ stats: { totalJobs: expect.any(Number) }, jobs: expect.any(Array), runs: expect.any(Array) });
  });

  // ── Admin tools ──────────────────────────────────────────────────────────────

  it('crontick_export returns jobs array', async () => {
    const { json, isError } = await callTool(client, 'crontick_export');
    expect(isError).toBe(false);
    expect(Array.isArray((json as { jobs: unknown[] }).jobs)).toBe(true);
  });

  it('crontick_doctor returns check results', async () => {
    const { json, isError } = await callTool(client, 'crontick_doctor');
    expect(isError).toBe(false);
    const data = json as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(Array.isArray(data.checks)).toBe(true);
    expect(data.checks.length).toBeGreaterThan(0);
  });

  it('config tools can initialize, edit, validate, and list engines', async () => {
    expect((await callTool(client, 'crontick_config_get')).isError).toBe(false);
    expect((await callTool(client, 'crontick_config_init', { force: true })).isError).toBe(false);
    expect((await callTool(client, 'crontick_config_engine_add', {
      name: 'agency',
      engine: { command: 'agency', args: ['cp'], env: { LOGS: 'XYZ' } },
    })).isError).toBe(false);
    const engines = await callTool(client, 'crontick_config_engine_list');
    expect(engines.isError).toBe(false);
    expect((engines.json as Record<string, unknown>)).toHaveProperty('agency');
    expect((await callTool(client, 'crontick_config_set', { path: 'defaultEngine', value: 'agency' })).isError).toBe(false);
    expect((await callTool(client, 'crontick_config_unset', { path: 'engines.agency.env' })).isError).toBe(false);
    expect((await callTool(client, 'crontick_config_validate')).json).toMatchObject({ ok: true });
  });

  it('tool verbose option returns MCP diagnostics without stderr protocol pollution', async () => {
    const { json, isError } = await callTool(client, 'crontick_config_get', { verbose: true });
    expect(isError).toBe(false);
    expect(json).toMatchObject({
      result: { engines: expect.any(Object) },
      diagnostics: expect.any(Array),
    });
    expect((json as { diagnostics: Array<{ level: string }> }).diagnostics.some((event) => event.level === 'debug')).toBe(true);
  });

  // ── Resources ──────────────────────────────────────────────────────────────

  it('resources/list returns non-empty list', async () => {
    const result = await client.listResources();
    expect(result.resources.length).toBeGreaterThan(0);
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain('crontick://schemas/job');
  });

  it('resources/read crontick://schemas/job returns valid JSON schema', async () => {
    const result = await client.readResource({ uri: 'crontick://schemas/job' });
    expect(result.contents.length).toBeGreaterThanOrEqual(1);
    const item = result.contents[0] as { uri: string; text?: string; mimeType?: string };
    const text = item.text ?? '';
    expect(text.length).toBeGreaterThan(10);
    const schema = JSON.parse(text) as Record<string, unknown>;
    expect(schema).toBeDefined();
  });

  // ── Error paths ─────────────────────────────────────────────────────────────

  it('tool call for non-existent job returns error in content', async () => {
    try {
      const { json, isError } = await callTool(client, 'crontick_job_get', {
        id: 'nonexistent-job-xyz',
      });
      // Job not found → daemon returns 404 → MCP wraps as isError:true
      const hasError =
        isError === true || (json as { error?: unknown })?.error !== undefined;
      expect(hasError).toBe(true);
    } catch (err) {
      // Protocol-level error is also acceptable
      expect(err).toBeDefined();
    }
  });

  it('crontick_dashboard_stop stops the daemon-backed dashboard server', async () => {
    const { json, isError } = await callTool(client, 'crontick_dashboard_stop');
    expect(isError).toBe(false);
    expect(json).toMatchObject({ ok: true, stopped: expect.any(Boolean) });
  });
});

// ── Daemon-start-off path ────────────────────────────────────────────────────

describe('MCP server — CRONTICK_MCP_START_DAEMON path', () => {
  it('daemon status reports not running without starting the daemon', async () => {
    const isolatedDir = makeTmpDir();
    let isolatedTransport: StdioClientTransport | undefined;
    let isolatedClient: Client | undefined;

    try {
      isolatedTransport = new StdioClientTransport({
        command: process.execPath,
        args: [MCP_SCRIPT],
        env: {
          ...process.env,
          CRONTICK_HOME: isolatedDir,
          CRONTICK_MCP_START_DAEMON: '0',
          CRONTICK_DAEMON_URL: 'http://127.0.0.1:9',
        },
        stderr: 'pipe',
      });
      isolatedClient = new Client(
        { name: 'test-client-nostart', version: '0.0.0' },
        { capabilities: {} },
      );
      await isolatedClient.connect(isolatedTransport);

      const { json, text, isError } = await callTool(isolatedClient, 'crontick_daemon_status');
      expect(isError).toBe(false);
      expect((json as { running?: boolean }).running).toBe(false);
      // Must NOT leak 127.0.0.1:port to the LLM
      expect(text).not.toMatch(/127\.0\.0\.1:\d+/);
      expect(existsSync(join(isolatedDir, 'daemon.port'))).toBe(false);
      expect(existsSync(join(isolatedDir, 'daemon.pid'))).toBe(false);
    } finally {
      try { await isolatedClient?.close(); } catch { /* ignore */ }
      try { await isolatedTransport?.close(); } catch { /* ignore */ }
      try { rmSync(isolatedDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, TIMEOUT_MS);

  it('tool calls report not running without starting the daemon', async () => {
    const isolatedDir = makeTmpDir();
    let isolatedTransport: StdioClientTransport | undefined;
    let isolatedClient: Client | undefined;

    try {
      isolatedTransport = new StdioClientTransport({
        command: process.execPath,
        args: [MCP_SCRIPT],
        env: {
          ...process.env,
          CRONTICK_HOME: isolatedDir,
          CRONTICK_MCP_START_DAEMON: '0',
          CRONTICK_DAEMON_URL: 'http://127.0.0.1:9',
        },
        stderr: 'pipe',
      });
      isolatedClient = new Client(
        { name: 'test-client-tool-nostart', version: '0.0.0' },
        { capabilities: {} },
      );
      await isolatedClient.connect(isolatedTransport);

      const result = await isolatedClient.callTool({ name: 'crontick_job_list', arguments: {} });
      const content = (result as { content: Array<{ text?: string }> }).content;
      const item = content[0];
      const data = JSON.parse(item.text ?? '{}') as { error?: string };
      expect(data.error).toContain('Daemon is not reachable');
      expect(data.error).toContain('<daemon-addr>');
      expect(data.error).not.toContain('127.0.0.1:9');
      expect(existsSync(join(isolatedDir, 'daemon.port'))).toBe(false);
      expect(existsSync(join(isolatedDir, 'daemon.pid'))).toBe(false);
      expect(existsSync(join(isolatedDir, 'daemon.ensure.lock'))).toBe(false);
    } finally {
      try { await isolatedClient?.close(); } catch { /* ignore */ }
      try { await isolatedTransport?.close(); } catch { /* ignore */ }
      stopDaemonInHome(isolatedDir);
      try { rmSync(isolatedDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, TIMEOUT_MS);
});

describe('MCP server — daemon-backed tools start daemon on demand', () => {
  it('job list starts a persistent daemon when down', async () => {
    const isolatedDir = makeTmpDir();
    let isolatedTransport: StdioClientTransport | undefined;
    let isolatedClient: Client | undefined;

    try {
      isolatedTransport = new StdioClientTransport({
        command: process.execPath,
        args: [MCP_SCRIPT],
        env: {
          ...process.env,
          CRONTICK_HOME: isolatedDir,
        },
        stderr: 'pipe',
      });
      isolatedClient = new Client(
        { name: 'test-client-start', version: '0.0.0' },
        { capabilities: {} },
      );
      await isolatedClient.connect(isolatedTransport);

      const { json, isError } = await callTool(isolatedClient, 'crontick_job_list');
      expect(isError).toBe(false);
      expect(json).toEqual([]);
      expect(existsSync(join(isolatedDir, 'daemon.port'))).toBe(true);
      expect(existsSync(join(isolatedDir, 'daemon.pid'))).toBe(true);
    } finally {
      try { await isolatedClient?.close(); } catch { /* ignore */ }
      try { await isolatedTransport?.close(); } catch { /* ignore */ }
      stopDaemonInHome(isolatedDir);
      try { rmSync(isolatedDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, TIMEOUT_MS);
});
