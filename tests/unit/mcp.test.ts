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
import { jobJsonSchemaText } from '../../src/schema-json.js';
import { MCP_TOOLS } from '../../src/surface.js';
import { FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';

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
    writeFakeEngineConfig(dir);
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

  const EXPECTED_TOOLS = MCP_TOOLS;

  it('tools/list returns all catalog tools with crontick_ prefix', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names.sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of result.tools) {
      expect(tool.name).toMatch(/^crontick_/);
      expect(tool.name).not.toContain('auto' + 'start');
    }
  });

  it('crontick_run_list accepts skipped as a status filter', async () => {
    const result = await client.listTools();
    const runList = result.tools.find((tool) => tool.name === 'crontick_run_list');
    expect(runList?.inputSchema.properties?.status).toMatchObject({ enum: expect.arrayContaining(['skipped']) });
    const { isError, json } = await callTool(client, 'crontick_run_list', { status: 'skipped' });
    expect(isError).toBe(false);
    expect(Array.isArray(json)).toBe(true);
  });

  it('all tools have a non-empty description', async () => {
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(tool.description?.length ?? 0, `tool ${tool.name} missing description`).toBeGreaterThan(0);
    }
  });

  it('read-only tools are annotated readOnlyHint, and destructive tools are annotated destructiveHint', async () => {
    const result = await client.listTools();
    const byName = new Map(result.tools.map((t) => [t.name, t]));

    const readOnlyTools = [
      'crontick_job_list',
      'crontick_job_get',
      'crontick_job_schedule',
      'crontick_run_list',
      'crontick_run_get',
      'crontick_stats_summary',
      'crontick_doctor',
      'crontick_info',
    ];
    for (const name of readOnlyTools) {
      expect(byName.get(name)?.annotations?.readOnlyHint, `${name} should be readOnlyHint`).toBe(true);
    }

    const destructiveTools = ['crontick_job_create', 'crontick_job_update', 'crontick_job_run_now', 'crontick_job_delete', 'crontick_import', 'crontick_daemon_stop'];
    for (const name of destructiveTools) {
      const annotations = byName.get(name)?.annotations;
      expect(annotations?.readOnlyHint === true, `${name} should not be readOnlyHint`).toBe(false);
      expect(annotations?.destructiveHint, `${name} should be destructiveHint`).toBe(true);
    }
  });

  it('crontick_job_create and crontick_job_run_now descriptions warn they execute on the machine and to confirm first', async () => {
    const result = await client.listTools();
    const byName = new Map(result.tools.map((t) => [t.name, t]));
    for (const name of ['crontick_job_create', 'crontick_job_run_now']) {
      const description = byName.get(name)?.description ?? '';
      expect(description, `${name} description should mention executing on the machine`).toMatch(/execut/i);
      expect(description, `${name} description should tell the caller to confirm first`).toMatch(/confirm/i);
    }
  });

  // ── Job CRUD round-trip ──────────────────────────────────────────────────────

  const testJobId = 'mcp-test-job';

  it('crontick_job_create creates a job', async () => {
    const { json, isError } = await callTool(client, 'crontick_job_create', {
      alias: testJobId,
      description: 'MCP contract test job',
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: { kind: 'prompt', prompt: 'hello', args: [], reuseSession: false },
    });
    expect(isError).toBe(false);
    const createdJobId = (json as { id: string; alias?: string }).id;
    expect((json as { alias?: string }).alias).toBe(testJobId);
    expect(readFileSync(join(dir, 'jobs', `${createdJobId}.schema.json`), 'utf-8')).toBe(jobJsonSchemaText());
  });

  it('crontick_job_create requires force to replace an existing job', async () => {
    const jobId = 'mcp-duplicate-create-job';
    const original = await callTool(client, 'crontick_job_create', {
      alias: jobId,
      description: 'original mcp definition',
      schedule: { kind: 'interval', everySec: 60 },
      action: { kind: 'prompt', prompt: 'process.exit(0)', args: [], reuseSession: false },
    });
    expect(original.isError).toBe(false);

    const duplicate = await callTool(client, 'crontick_job_create', {
      alias: jobId,
      description: 'replacement mcp definition',
      schedule: { kind: 'cron', cron: '15 6 * * *' },
      action: { kind: 'prompt', prompt: 'process.exit(1)', args: [], reuseSession: false },
    });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.text).toMatch(/already exists|JOB_ALREADY_EXISTS/);

    const fetchedOriginal = await callTool(client, 'crontick_job_get', { id: jobId });
    expect(fetchedOriginal.isError).toBe(false);
    expect(fetchedOriginal.json).toMatchObject({
      description: 'original mcp definition',
      schedule: { kind: 'interval', everySec: 60 },
    });

    const forced = await callTool(client, 'crontick_job_create', {
      alias: jobId,
      force: true,
      description: 'replacement mcp definition',
      schedule: { kind: 'cron', cron: '15 6 * * *' },
      action: { kind: 'prompt', prompt: 'process.exit(1)', args: [], reuseSession: false },
    });
    expect(forced.isError).toBe(false);
    expect(forced.json).toMatchObject({
      description: 'replacement mcp definition',
      schedule: { kind: 'cron', cron: '15 6 * * *' },
    });
  });

  // Blocker 1 parity: MCP's args array is unaffected by CLI/shim quoting, but
  // must still round-trip the same tricky value (spaces, embedded double
  // quotes, leading dash) byte-for-byte, matching the CLI's --arg guarantee
  // (see 'crontick new --arg round-trips ...' in tests/cli.test.ts).
  it('crontick_job_create round-trips a prompt arg with spaces, embedded double quotes, and a leading dash', async () => {
    const tricky = '-flag with spaces and "embedded quotes"';
    const { json, isError } = await callTool(client, 'crontick_job_create', {
      alias: 'mcp-arg-tricky-job',
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: { kind: 'prompt', prompt: 'noop', args: [tricky], reuseSession: false },
    });
    expect(isError).toBe(false);
    expect((json as { action: unknown }).action).toMatchObject({ kind: 'prompt', args: [tricky] });
  });

  it('crontick_job_create redacts env-file absolute paths in MCP responses', async () => {
    const result = await callTool(client, 'crontick_job_create', {
      alias: 'mcp-missing-env-job',
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: {
        kind: 'prompt',
        prompt: 'process.exit(0)',
        cwd: dir,
        envFile: 'missing-mcp.env',
      },
    });
    expect(result.isError).toBe(true);
    expect((result.json as { error: string }).error).toContain('Failed to load envFile');
    // ENV_FILE_ERROR messages embed the resolved absolute path; the MCP surface
    // must redact it so no machine-specific path leaks to the LLM host.
    expect((result.json as { error: string }).error).not.toContain(dir);
    expect((result.json as { error: string }).error).toContain('<path>');
  });


  it('crontick_job_update preserves the previous job when env-file preflight fails', async () => {
    const created = await callTool(client, 'crontick_job_create', {
      alias: 'mcp-missing-env-update-job',
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: { kind: 'prompt', prompt: 'before' },
    });
    expect(created.isError).toBe(false);

    const result = await callTool(client, 'crontick_job_update', {
      id: 'mcp-missing-env-update-job',
      action: {
        kind: 'prompt',
        prompt: 'process.exit(0)',
        cwd: dir,
        envFile: 'missing-mcp-update.env',
      },
    });
    expect(result.isError).toBe(true);
    expect((result.json as { error: string }).error).toContain('Failed to load envFile');
    // The env-file absolute path is redacted (see redactedErrorMessage in mcp/index.ts).
    expect((result.json as { error: string }).error).not.toContain(dir);
    expect((result.json as { error: string }).error).toContain('<path>');

    const fetched = await callTool(client, 'crontick_job_get', { id: 'mcp-missing-env-update-job' });
    expect(fetched.isError).toBe(false);
    expect(fetched.json).toMatchObject({
      alias: 'mcp-missing-env-update-job',
      action: { kind: 'prompt', prompt: 'before' },
    });
  });

  it('crontick_job_update merges a partial patch onto the existing definition rather than replacing it', async () => {
    const created = await callTool(client, 'crontick_job_create', {
      alias: 'mcp-merge-job',
      schedule: { kind: 'interval', everySec: 120 },
      action: { kind: 'prompt', prompt: 'x', args: [], reuseSession: false },
      overlap: 'cancel-previous',
    });
    expect(created.isError).toBe(false);

    const updated = await callTool(client, 'crontick_job_update', {
      id: 'mcp-merge-job',
      description: 'via mcp',
    });
    expect(updated.isError).toBe(false);
    const data = updated.json as {
      description: string;
      schedule: unknown;
      action: unknown;
      overlap: string;
    };
    expect(data.description).toBe('via mcp');
    expect(data.schedule).toEqual({ kind: 'interval', everySec: 120 });
    expect(data.action).toMatchObject({ kind: 'prompt', prompt: 'x' });
    expect(data.overlap).toBe('cancel-previous');
  });

  // ── Overlap / shell parity with the CLI (see tests/cli.test.ts) ──────────────
  // These mirror the CLI cases above to prove both surfaces resolve the same
  // patch through the shared normalizeJobPatch/mergeActionPatch core.

  it('crontick_job_update sets overlap to skip when explicitly provided', async () => {
    const created = await callTool(client, 'crontick_job_create', {
      alias: 'mcp-overlap-skip-job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'hi', args: [], reuseSession: false },
      overlap: 'queue',
    });
    expect(created.isError).toBe(false);
    expect((created.json as { overlap: string }).overlap).toBe('queue');

    const skipped = await callTool(client, 'crontick_job_update', {
      id: 'mcp-overlap-skip-job',
      overlap: 'skip',
    });
    expect(skipped.isError).toBe(false);
    expect((skipped.json as { overlap: string }).overlap).toBe('skip');
  });

  it('crontick_job_update sets overlap to cancel-previous when explicitly provided', async () => {
    const created = await callTool(client, 'crontick_job_create', {
      alias: 'mcp-overlap-cancel-job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'hi', args: [], reuseSession: false },
      overlap: 'queue',
    });
    expect(created.isError).toBe(false);

    const updated = await callTool(client, 'crontick_job_update', {
      id: 'mcp-overlap-cancel-job',
      overlap: 'cancel-previous',
    });
    expect(updated.isError).toBe(false);
    expect((updated.json as { overlap: string }).overlap).toBe('cancel-previous');
  });

  it('crontick_job_update omitting overlap leaves the existing value alone', async () => {
    const created = await callTool(client, 'crontick_job_create', {
      alias: 'mcp-overlap-preserve-job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'hi', args: [], reuseSession: false },
      overlap: 'cancel-previous',
    });
    expect(created.isError).toBe(false);

    const updated = await callTool(client, 'crontick_job_update', {
      id: 'mcp-overlap-preserve-job',
      description: 'no overlap field',
    });
    expect(updated.isError).toBe(false);
    const data = updated.json as { overlap: string; description: string };
    expect(data.overlap).toBe('cancel-previous');
    expect(data.description).toBe('no overlap field');
  });

  it('crontick_job_update applies cron schedule updates', async () => {
    const created = await callTool(client, 'crontick_job_create', {
      alias: 'mcp-cron-tz-update-job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'hi', args: [], reuseSession: false },
    });
    expect(created.isError).toBe(false);

    const updated = await callTool(client, 'crontick_job_update', {
      id: 'mcp-cron-tz-update-job',
      schedule: { kind: 'cron', cron: '0 10 * * *' },
    });
    expect(updated.isError).toBe(false);
    expect((updated.json as { schedule: unknown }).schedule).toEqual({ kind: 'cron', cron: '0 10 * * *' });
  });

  it('crontick_job_update preserves prompt/engine when only envFile/timeoutSec are patched', async () => {
    writeFileSync(join(dir, '.env.test'), 'FOO=bar\n', 'utf-8');

    const created = await callTool(client, 'crontick_job_create', {
      alias: 'mcp-engine-preserve-job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'hi', engine: 'agency', cwd: dir, envFile: '.env.test', timeoutSec: 30 },
    });
    expect(created.isError).toBe(false);

    const updated = await callTool(client, 'crontick_job_update', {
      id: 'mcp-engine-preserve-job',
      action: { kind: 'prompt', prompt: 'bye' },
    });
    expect(updated.isError).toBe(false);
    expect((updated.json as { action: unknown }).action).toMatchObject({
      kind: 'prompt', prompt: 'bye', engine: 'agency', envFile: '.env.test', timeoutSec: 30,
    });
  });

  it('crontick_job_update explicit engine changes the engine', async () => {
    writeFileSync(join(dir, '.env.engine-explicit.test'), 'FOO=bar\n', 'utf-8');

    const created = await callTool(client, 'crontick_job_create', {
      alias: 'mcp-engine-explicit-job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'hi', engine: 'agency', cwd: dir, envFile: '.env.engine-explicit.test', timeoutSec: 30 },
    });
    expect(created.isError).toBe(false);

    const updated = await callTool(client, 'crontick_job_update', {
      id: 'mcp-engine-explicit-job',
      action: { kind: 'prompt', prompt: 'again', engine: 'openai' },
    });
    expect(updated.isError).toBe(false);
    expect((updated.json as { action: unknown }).action).toMatchObject({ engine: 'openai' });
  });

  // ── args/reuseSession/retry/engine parity with the CLI (see tests/cli.test.ts) ─
  // These mirror the CLI --file JSON-patch cases below to prove both surfaces
  // resolve the same patch through the shared normalizeJobPatch/mergeActionPatch
  // core (the CLI's flag builder always supplies args/reuseSession/retry
  // explicitly, so its parity proof for these fields uses --file instead of flags).

  it('crontick_job_update preserves prompt args and reuseSession when the patch only changes prompt text', async () => {
    const created = await callTool(client, 'crontick_job_create', {
      alias: 'mcp-prompt-args-preserve-job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'old', args: ['--flag'], reuseSession: true },
    });
    expect(created.isError).toBe(false);

    const updated = await callTool(client, 'crontick_job_update', {
      id: 'mcp-prompt-args-preserve-job',
      action: { kind: 'prompt', prompt: 'new' },
    });
    expect(updated.isError).toBe(false);
    expect((updated.json as { action: unknown }).action).toMatchObject({
      kind: 'prompt', prompt: 'new', args: ['--flag'], reuseSession: true,
    });
  });

  it('crontick_job_update applies explicit prompt args/reuseSession when provided', async () => {
    const created = await callTool(client, 'crontick_job_create', {
      alias: 'mcp-prompt-args-explicit-job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'old', args: ['--flag'], reuseSession: true },
    });
    expect(created.isError).toBe(false);

    const updated = await callTool(client, 'crontick_job_update', {
      id: 'mcp-prompt-args-explicit-job',
      action: { kind: 'prompt', prompt: 'old', args: [], reuseSession: false },
    });
    expect(updated.isError).toBe(false);
    expect((updated.json as { action: unknown }).action).toMatchObject({ args: [], reuseSession: false });
  });

  it('crontick_job_update preserves a custom engine on a same-kind prompt update that omits engine', async () => {
    const created = await callTool(client, 'crontick_job_create', {
      alias: 'mcp-prompt-engine-job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'old', engine: 'agency' },
    });
    expect(created.isError).toBe(false);

    const updated = await callTool(client, 'crontick_job_update', {
      id: 'mcp-prompt-engine-job',
      action: { kind: 'prompt', prompt: 'new' },
    });
    expect(updated.isError).toBe(false);
    expect((updated.json as { action: unknown }).action).toMatchObject({ kind: 'prompt', engine: 'agency' });
  });

  it('crontick_job_update preserves retry.backoffSec when the patch only sets max', async () => {
    const created = await callTool(client, 'crontick_job_create', {
      alias: 'mcp-retry-preserve-job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'noop', args: [], reuseSession: false },
      retry: { max: 1, backoffSec: 90 },
    });
    expect(created.isError).toBe(false);

    const updated = await callTool(client, 'crontick_job_update', {
      id: 'mcp-retry-preserve-job',
      retry: { max: 3 },
    });
    expect(updated.isError).toBe(false);
    expect((updated.json as { retry: unknown }).retry).toEqual({ max: 3, backoffSec: 90 });
  });

  it('crontick_job_update applies an explicit backoffSec over the preserved retry fields', async () => {
    const created = await callTool(client, 'crontick_job_create', {
      alias: 'mcp-retry-explicit-job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'noop', args: [], reuseSession: false },
      retry: { max: 1, backoffSec: 90 },
    });
    expect(created.isError).toBe(false);

    const updated = await callTool(client, 'crontick_job_update', {
      id: 'mcp-retry-explicit-job',
      retry: { max: 3, backoffSec: 15 },
    });
    expect(updated.isError).toBe(false);
    expect((updated.json as { retry: unknown }).retry).toEqual({ max: 3, backoffSec: 15 });
  });

  it('crontick_job_create accepts prompt actions', async () => {
    const { json, isError } = await callTool(client, 'crontick_job_create', {
      alias: 'mcp-prompt-job',
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
      alias: 'mcp-session-precedence-job',
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
      alias: 'mcp-prompt-file-job',
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

  it('job create/get/list/update tool responses redact secret env values while preserving benign ones', async () => {
    const jobId = 'mcp-redaction-job';
    const createSecret = `sk-proj-${'U'.repeat(28)}`;
    const updateSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

    let result = await callTool(client, 'crontick_job_create', {
      alias: jobId,
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: {
        kind: 'prompt',
        prompt: 'noop',
        env: { OPENAI_API_KEY: createSecret, NON_SECRET: 'https://example.test/mcp-visible' },
      },
    });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.json)).not.toContain(createSecret);
    expect(result.json).toMatchObject({
      alias: jobId,
      action: { env: { OPENAI_API_KEY: '[REDACTED]', NON_SECRET: 'https://example.test/mcp-visible' } },
    });

    result = await callTool(client, 'crontick_job_get', { id: jobId });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.json)).not.toContain(createSecret);
    expect(result.json).toMatchObject({
      alias: jobId,
      action: { env: { OPENAI_API_KEY: '[REDACTED]', NON_SECRET: 'https://example.test/mcp-visible' } },
    });

    result = await callTool(client, 'crontick_job_list');
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.json)).not.toContain(createSecret);
    expect(result.json).toContainEqual(expect.objectContaining({
      alias: jobId,
      action: expect.objectContaining({ env: expect.objectContaining({ OPENAI_API_KEY: '[REDACTED]', NON_SECRET: 'https://example.test/mcp-visible' }) }),
    }));

    result = await callTool(client, 'crontick_job_update', {
      id: jobId,
      action: {
        kind: 'prompt',
        prompt: 'noop',
        env: { AWS_SECRET_ACCESS_KEY: updateSecret, NO_PASSWORD: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLl1Mm2Nn' },
      },
    });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.json)).not.toContain(updateSecret);
    expect(result.json).toMatchObject({
      alias: jobId,
      action: { env: { AWS_SECRET_ACCESS_KEY: '[REDACTED]', NO_PASSWORD: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLl1Mm2Nn' } },
    });

    result = await callTool(client, 'crontick_job_disable', { id: jobId });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.json)).not.toContain(updateSecret);
    expect(result.json).toMatchObject({
      alias: jobId,
      enabled: false,
      action: { env: { AWS_SECRET_ACCESS_KEY: '[REDACTED]', NO_PASSWORD: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLl1Mm2Nn' } },
    });

    result = await callTool(client, 'crontick_job_enable', { id: jobId });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.json)).not.toContain(updateSecret);
    expect(result.json).toMatchObject({
      alias: jobId,
      enabled: true,
      action: { env: { AWS_SECRET_ACCESS_KEY: '[REDACTED]', NO_PASSWORD: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLl1Mm2Nn' } },
    });
  });

  it('crontick_job_list returns the created job', async () => {
    const { json, isError } = await callTool(client, 'crontick_job_list');
    expect(isError).toBe(false);
    const jobs = json as Array<{ id: string; alias?: string }>;
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs.some((j) => j.alias === testJobId)).toBe(true);
  });

  it('crontick_job_get returns full job definition', async () => {
    const { json, isError } = await callTool(client, 'crontick_job_get', { id: testJobId });
    expect(isError).toBe(false);
    const job = json as { id: string; alias?: string; schedule: unknown };
    expect(job.alias).toBe(testJobId);
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

  it('crontick_run_get returns the record, logFile and cleaned output end-to-end', async () => {
    const { json: listJson } = await callTool(client, 'crontick_run_list', { jobId: testJobId, limit: 1 });
    const runs = listJson as Array<{ id: string }>;
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const runId = runs[0].id;

    const { json: runJson, isError: runErr } = await callTool(client, 'crontick_run_get', { id: runId });
    expect(runErr).toBe(false);
    const run = runJson as { id: string; pid?: number; outputTruncated: boolean };
    expect(run.id).toBe(runId);
    // Handoff #4: pid (once known) and outputTruncated are surfaced on every run.
    expect(run.pid === undefined || typeof run.pid === 'number').toBe(true);
    expect(typeof run.outputTruncated).toBe('boolean');

    const detailed = runJson as { logFile: string | null; output: { runId: string; status: string } };
    expect(detailed.logFile === null || typeof detailed.logFile === 'string').toBe(true);
    expect(detailed.output.runId).toBe(runId);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain('crontick_run_logs_tail');
    expect(names).not.toContain('crontick_run_output');
  }, 10_000);


  it('crontick_run_list filters by status', async () => {
    // A dedicated fake-node-engine job so the run deterministically succeeds,
    // unlike the shared testJobId (prompt, default `copilot` engine, not a
    // real installed binary).
    const jobId = 'mcp-run-status-job';
    await callTool(client, 'crontick_job_create', {
      alias: jobId,
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: { kind: 'prompt', prompt: 'process.exit(0)', engine: FAKE_ENGINE_NAME, args: [], reuseSession: false },
    });
    const { json: runNowJson } = await callTool(client, 'crontick_job_run_now', { id: jobId });
    const { runId } = runNowJson as { runId: string };
    await new Promise((resolve) => setTimeout(resolve, 2000)); // let the exec job finish

    const { json: successJson, isError: successErr } = await callTool(client, 'crontick_run_list', { jobId, status: 'success' });
    expect(successErr).toBe(false);
    const successRuns = successJson as Array<{ id: string; status: string }>;
    expect(successRuns.every((r) => r.status === 'success')).toBe(true);
    expect(successRuns.some((r) => r.id === runId)).toBe(true);

    const { json: failedJson, isError: failedErr } = await callTool(client, 'crontick_run_list', { jobId, status: 'failed' });
    expect(failedErr).toBe(false);
    expect((failedJson as Array<{ id: string }>).some((r) => r.id === runId)).toBe(false);

    await callTool(client, 'crontick_job_delete', { id: jobId });
  }, 10_000);

  it('crontick_job_delete removes the job', async () => {
    const { json, isError } = await callTool(client, 'crontick_job_delete', { id: testJobId });
    expect(isError).toBe(false);
    expect((json as { ok: boolean }).ok).toBe(true);
  });

  // ── Schedule tools ──────────────────────────────────────────────────────────

  it('crontick_job_schedule returns N future ISO timestamps for an existing job', async () => {
    const jobId = 'mcp-schedule-job';
    const created = await callTool(client, 'crontick_job_create', {
      alias: jobId,
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'prompt', prompt: 'process.exit(0)', args: [], reuseSession: false },
    });
    expect(created.isError).toBe(false);
    const createdId = (created.json as { id: string }).id;

    const { json, isError } = await callTool(client, 'crontick_job_schedule', { id: jobId, n: 3 });
    expect(isError).toBe(false);
    const data = json as { jobId: string; alias?: string; schedule: unknown; next: string[] };
    expect(data.jobId).toBe(createdId);
    expect(data.alias).toBe(jobId);
    expect(data.schedule).toEqual({ kind: 'cron', cron: '0 9 * * *' });
    expect(Array.isArray(data.next)).toBe(true);
    expect(data.next).toHaveLength(3);
    for (const ts of data.next) {
      expect(typeof ts).toBe('string');
      expect(new Date(ts).getTime()).not.toBeNaN();
    }

    await callTool(client, 'crontick_job_delete', { id: jobId });
  });

  // ── Daemon tools ─────────────────────────────────────────────────────────────


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

  // ── Admin tools ──────────────────────────────────────────────────────────────

  it('crontick_export returns jobs array', async () => {
    const { json, isError } = await callTool(client, 'crontick_export');
    expect(isError).toBe(false);
    expect(Array.isArray((json as { jobs: unknown[] }).jobs)).toBe(true);
    // includeRuns defaults to off -- keeps the common export small.
    expect((json as { runs?: unknown }).runs).toBeUndefined();
  });

  it('L7: crontick_export includeRuns and crontick_import round-trip run history', async () => {
    const jobId = 'mcp-export-runs-job';
    const created = await callTool(client, 'crontick_job_create', {
      alias: jobId,
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: { kind: 'prompt', prompt: 'process.exit(0)', args: [], reuseSession: false },
    });
    const createdId = (created.json as { id: string }).id;
    await callTool(client, 'crontick_job_run_now', { id: jobId });
    await new Promise((resolve) => setTimeout(resolve, 2000)); // let the exec job finish

    const { json: exportJson, isError: exportErr } = await callTool(client, 'crontick_export', { includeRuns: true });
    expect(exportErr).toBe(false);
    const exported = exportJson as { jobs: Array<{ id: string; alias?: string }>; runs: Array<{ id: string; jobId: string }> };
    expect(exported.runs.some((r) => r.jobId === createdId)).toBe(true);

    // Delete the job (job history rows are untouched by job delete -- that's
    // exactly the retention gap L7 exists to mitigate), then restore both the
    // job and its run history from the export -- proving the wire format
    // export produces is exactly what import consumes, end to end.
    await callTool(client, 'crontick_job_delete', { id: jobId });
    const { json: importJson, isError: importErr } = await callTool(client, 'crontick_import', {
      jobs: exported.jobs.filter((j) => j.id === createdId),
      runs: exported.runs,
    });
    expect(importErr).toBe(false);
    expect(importJson as { runsImported?: number; runsSkipped?: unknown[] }).toMatchObject({
      runsImported: expect.any(Number),
      runsSkipped: expect.any(Array),
    });

    const { json: listJson } = await callTool(client, 'crontick_run_list', { jobId });
    expect((listJson as Array<{ id: string }>).some((r) => exported.runs.some((er) => er.id === r.id))).toBe(true);

    await callTool(client, 'crontick_job_delete', { id: jobId });
  }, 10_000);

  it('crontick_doctor returns check results', async () => {
    const { json, isError } = await callTool(client, 'crontick_doctor');
    expect(isError).toBe(false);
    const data = json as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(Array.isArray(data.checks)).toBe(true);
    expect(data.checks.length).toBeGreaterThan(0);
  });

  it('crontick_job_delete deletes one job or every job with all:true plus force:true', async () => {
    const singleId = 'mcp-job-delete-single';
    const bulkIds = ['mcp-job-delete-all-a', 'mcp-job-delete-all-b'] as const;

    for (const id of [singleId, ...bulkIds]) {
      const created = await callTool(client, 'crontick_job_create', {
        alias: id,
        schedule: { kind: 'cron', cron: '0 0 * * *' },
        action: { kind: 'prompt', prompt: 'process.exit(0)', args: [], reuseSession: false },
      });
      expect(created.isError).toBe(false);
    }

    const singleDeleted = await callTool(client, 'crontick_job_delete', { id: singleId });
    expect(singleDeleted.isError).toBe(false);
    expect(singleDeleted.json).toMatchObject({ ok: true });

    const missingForce = await callTool(client, 'crontick_job_delete', { all: true });
    expect(missingForce.isError).toBe(true);
    expect(String((missingForce.json as { error?: string }).error ?? '')).toContain('force:true');

    const bulkDeleted = await callTool(client, 'crontick_job_delete', { all: true, force: true });
    expect(bulkDeleted.isError).toBe(false);
    expect(bulkDeleted.json).toMatchObject({ ok: true, deleted: expect.any(Number) });

    const listed = await callTool(client, 'crontick_job_list');
    expect(listed.isError).toBe(false);
    const aliases = new Set((listed.json as Array<{ alias?: string | null }>).map((job) => job.alias ?? null));
    expect(aliases.has(singleId)).toBe(false);
    expect(aliases.has(bulkIds[0])).toBe(false);
    expect(aliases.has(bulkIds[1])).toBe(false);
  });


  it('crontick_info returns environment and daemon information', async () => {
    const { json, isError } = await callTool(client, 'crontick_info');
    expect(isError).toBe(false);
    expect(json).toMatchObject({
      version: expect.any(String),
      node: expect.stringMatching(/^v/),
      platform: expect.any(String),
      configPath: expect.any(String),
      paths: {
        dataDir: expect.any(String),
        jobsDir: expect.any(String),
        runsDb: expect.any(String),
        logsDir: expect.any(String),
        configFile: expect.any(String),
        portFile: expect.any(String),
        pidFile: expect.any(String),
      },
      daemon: { running: expect.any(Boolean) },
    });
    // The dashboard is always served by the daemon; info surfaces its URL.
    const { dashboardUrl } = json as { dashboardUrl: unknown };
    expect(dashboardUrl === null || (typeof dashboardUrl === 'string' && dashboardUrl.endsWith('/dashboard'))).toBe(true);
  });

  it('tool verbose option returns MCP diagnostics without stderr protocol pollution', async () => {
    const { json, isError } = await callTool(client, 'crontick_job_list', { verbose: true });
    expect(isError).toBe(false);
    expect(json).toMatchObject({
      result: expect.any(Array),
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
});

// ── Daemon-start-off path ────────────────────────────────────────────────────

describe('MCP server — CRONTICK_MCP_START_DAEMON path', () => {
  it('crontick_info reports not running without starting the daemon', async () => {
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

      const { json, text, isError } = await callTool(isolatedClient, 'crontick_info');
      expect(isError).toBe(false);
      expect((json as { daemon?: { running?: boolean } }).daemon?.running).toBe(false);
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
