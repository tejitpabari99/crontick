import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createClient, type RunRecord } from '../../src/index.js';
import { fakeClaudeEngineConfig } from '../helpers/fake-claude.js';

const CLI = resolve('dist/cli/index.js');
const MCP = resolve('dist/mcp/index.js');
const DAEMON = resolve('dist/daemon/index.js');
const home = mkdtempSync(join(tmpdir(), 'crontick-run-usage-surfaces-'));
const env = { ...process.env, CRONTICK_HOME: home };
const client = createClient({ env, daemonScript: DAEMON, startupTimeoutMs: 15_000 });
let baseUrl = '';
let mcp: Client;
let transport: StdioClientTransport;

function cli(args: string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', env: { ...env, CRONTICK_DAEMON_URL: baseUrl },
  });
  expect(result.status, result.stderr).toBe(0);
  return Object.fromEntries(result.stdout.trim().split(/\r?\n/).map((line) => {
    const separator = line.indexOf(': ');
    const raw = line.slice(separator + 2);
    try { return [line.slice(0, separator), JSON.parse(raw)]; }
    catch { return [line.slice(0, separator), raw]; }
  }));
}

async function tool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await mcp.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text?: string }> };
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

async function terminalRun(id: string): Promise<RunRecord> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const run = await client.getRun(id);
    if (run.status !== 'queued' && run.status !== 'running') return run;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for run ${id}`);
}

beforeAll(async () => {
  mkdirSync(join(home, 'jobs'));
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    defaultEngine: 'test-claude',
    engines: {
      'test-claude': fakeClaudeEngineConfig({ usage: { input_tokens: 10, output_tokens: 5, api_key: 'top-secret' } }),
      'test-raw': { command: process.execPath, args: ['-e'], type: 'raw' },
    },
  }));
  baseUrl = (await client.ensure()).baseUrl;
  transport = new StdioClientTransport({
    command: process.execPath, args: [MCP],
    env: { ...env, CRONTICK_DAEMON_URL: baseUrl, CRONTICK_MCP_START_DAEMON: '0' },
    stderr: 'pipe',
  });
  mcp = new Client({ name: 'run-usage-surfaces-test', version: '0.0.0' }, { capabilities: {} });
  await mcp.connect(transport);
}, 20_000);

afterAll(async () => {
  try { await mcp?.close(); } catch { /* ignore */ }
  try { await transport?.close(); } catch { /* ignore */ }
  try { await client.daemonStop(); } catch { /* ignore */ }
  rmSync(home, { recursive: true, force: true });
});

describe('Claude run metadata across surfaces', () => {
  it('returns redacted usage through library, CLI, MCP and aggregates cost/turns in stats', async () => {
    const definition = (alias: string, engine: string, prompt: string) => ({
      alias,
      schedule: { kind: 'interval' as const, everySec: 3600 },
      action: { kind: 'prompt' as const, engine, prompt, args: [], reuseSession: false, cwd: home },
    });
    const claudeJob = await client.createJob(definition('usage-claude', 'test-claude', 'hello'));
    const claudeId = (await client.runNow(claudeJob.id)).runId;
    const libraryRun = await terminalRun(claudeId);
    expect(libraryRun).toMatchObject({ costUsd: 0.01, turns: 1, engineStatus: 'success' });
    expect(libraryRun.transcriptPath).toContain(libraryRun.sessionId);
    expect(JSON.parse(libraryRun.usageJson!)).toEqual({ input_tokens: 10, output_tokens: 5, api_key: '[REDACTED]' });
    const cliJson = spawnSync(process.execPath, [CLI, 'runs', 'get', claudeId, '--json'], { encoding: 'utf8', env: { ...env, CRONTICK_DAEMON_URL: baseUrl } });
    expect(cliJson.status, cliJson.stderr).toBe(0);
    expect((JSON.parse(cliJson.stdout) as { run: unknown }).run).toMatchObject({
      id: claudeId,
      costUsd: 0.01,
      turns: 1,
      engineStatus: 'success',
      transcriptPath: libraryRun.transcriptPath,
      usageJson: libraryRun.usageJson,
    });
    expect(await tool('crontick_run_get', { id: claudeId })).toMatchObject(libraryRun);

    const rawJob = await client.createJob(definition('usage-raw', 'test-raw', 'process.exit(0)'));
    const rawId = (await client.runNow(rawJob.id)).runId;
    const rawRun = await terminalRun(rawId);
    expect(rawRun.status).toBe('success');
    for (const field of ['costUsd', 'turns', 'usageJson', 'transcriptPath', 'engineStatus']) {
      expect(field in rawRun).toBe(false);
    }

    const summary = await client.statsSummary();
    expect(summary).toMatchObject({ totalCostUsd: 0.01, totalTurns: 1 });
    expect(cli(['stats', 'summary'])).toMatchObject(summary);
    expect(await tool('crontick_stats_summary')).toMatchObject(summary);
    const jobStats = await client.statsJob(claudeJob.id);
    expect(jobStats).toMatchObject({ totalCostUsd: 0.01, totalTurns: 1 });
    const { lastRunAt, totalTurns, ...stable } = jobStats;
    const cliStats = cli(['stats', 'job', claudeJob.id]);
    expect(cliStats).toMatchObject(stable);
    // CLI presents lastRunAt as local ISO-8601 and labels totalTurns; JSON/MCP keep raw values.
    expect(cliStats['lastRunAt']).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    expect(typeof lastRunAt).toBe('number');
    expect(cliStats['totalTurns (agent turns, summed over runs)']).toBe(totalTurns);
    expect(await tool('crontick_stats_job', { id: claudeJob.id })).toMatchObject(jobStats);
  }, 25_000);
});
