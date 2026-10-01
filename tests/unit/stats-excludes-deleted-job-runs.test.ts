import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ORPHAN_RUN_ERROR_CODE, ORPHAN_RUN_ERROR_MESSAGE, createClient } from '../../src/index.js';
import { FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';

const CLI = resolve('dist', 'cli', 'index.js');
const MCP = resolve('dist', 'mcp', 'index.js');
const DAEMON_SCRIPT = resolve('dist', 'daemon', 'index.js');
const HOME = resolve('.crontick', 'stats-excludes-deleted-job-runs-ctd-014');

type StatsSummary = {
  totalJobs: number;
  enabledJobs: number;
  succeeded: number;
  failed: number;
  avgDurationSec: number | null;
  totalCostUsd: number;
  totalTurns: number;
};

type DashboardPayload = {
  health: {
    jobs: { total: number; enabled: number };
    runs: { last24h: number; failures24h: number };
  };
  stats: StatsSummary;
  jobs: Array<{ id: string; alias?: string | null }>;
  runs: Array<{ id: string; jobId: string; jobAlias?: string | null }>;
};

type RunRecord = {
  id: string;
  jobId: string;
  status: string;
  exitCode?: number;
};

type ToolCallJson = { error?: string; [key: string]: unknown };

const env = {
  ...process.env,
  CRONTICK_HOME: HOME,
};

let baseUrl = '';
const client = createClient({ env, daemonScript: DAEMON_SCRIPT, startupTimeoutMs: 15_000 });
let mcpClient: Client;
let mcpTransport: StdioClientTransport;

function resetHome(): void {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(HOME, 'jobs'), { recursive: true });
  mkdirSync(join(HOME, 'logs'), { recursive: true });
  writeFakeEngineConfig(HOME);
}

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...env,
      CRONTICK_DAEMON_URL: baseUrl,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}


function parseDisplay(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (trimmed === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^[{["]/.test(trimmed)) try { return JSON.parse(trimmed); } catch { /* keep string */ }
  return value;
}

function parseCliObject<T extends Record<string, unknown> = Record<string, unknown>>(stdout: string): T {
  const out: Record<string, unknown> = {};
  for (const line of stdout.trim().split(/\r?\n/)) {
    const idx = line.indexOf(': ');
    if (idx >= 0) out[line.slice(0, idx)] = parseDisplay(line.slice(idx + 2));
  }
  return out as T;
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForTerminalRun(runId: string, maxMs = 15_000): Promise<RunRecord> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const run = await client.getRun(runId) as RunRecord;
    if (run.status !== 'queued' && run.status !== 'running') return run;
    await delay(100);
  }
  throw new Error(`Timed out waiting for run ${runId}`);
}

function jobDefinition(id: string, line: string) {
  return {
    alias: id,
    schedule: { kind: 'interval' as const, everySec: 3600 },
    action: {
      kind: 'prompt' as const,
      prompt: `console.log(${JSON.stringify(line)})`,
      engine: FAKE_ENGINE_NAME,
      args: [],
      reuseSession: false,
    },
  };
}

beforeAll(async () => {
  resetHome();
  const daemon = await client.ensure();
  baseUrl = daemon.baseUrl;

  mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP],
    env: {
      ...env,
      CRONTICK_DAEMON_URL: baseUrl,
      CRONTICK_MCP_START_DAEMON: '0',
    },
    stderr: 'pipe',
  });
  mcpClient = new Client({ name: 'ctd-014-test-client', version: '0.0.0' }, { capabilities: {} });
  await mcpClient.connect(mcpTransport);
}, 20_000);

afterAll(async () => {
  try { await mcpClient?.close(); } catch { /* ignore */ }
  try { await mcpTransport?.close(); } catch { /* ignore */ }
  try { await client.daemonStop(); } catch { /* ignore */ }
  rmSync(HOME, { recursive: true, force: true });
});

describe('deleted-job aggregates', () => {
  it('removes deleted-job runs/output from every surface (stats, dashboard, runs list/get, output)', async () => {
    const liveJobId = 'ctd-014-live-job';
    const deletedJobId = 'ctd-014-deleted-job';

    const liveJob = await client.createJob(jobDefinition(liveJobId, 'live-history'));
    const deletedJob = await client.createJob(jobDefinition(deletedJobId, 'deleted-history'));

    const liveRunId = (await client.runNow(liveJobId) as { runId: string }).runId;
    await waitForTerminalRun(liveRunId);
    await delay(50);

    const deletedRunId = (await client.runNow(deletedJobId) as { runId: string }).runId;
    await waitForTerminalRun(deletedRunId);

    const beforeDelete = await client.statsSummary();
    expect(beforeDelete).toMatchObject({ totalJobs: 2, enabledJobs: 2, succeeded: 2, failed: 0 });

    const deletion = await client.deleteJob(deletedJobId);
    expect(deletion).toMatchObject({ ok: true, deletedRuns: 1 });

    const summary = await client.statsSummary();
    expect(summary).toEqual({
      totalJobs: 1,
      enabledJobs: 1,
      succeeded: 1,
      failed: 0,
      canceled: 0,
      skipped: 0,
      avgDurationSec: expect.any(Number),
      totalCostUsd: 0,
      totalTurns: 0,
    });

    const cliSummaryResult = cli(['stats', 'summary']);
    expect(cliSummaryResult.status, cliSummaryResult.stderr).toBe(0);
    expect(parseCliObject<StatsSummary>(cliSummaryResult.stdout)).toEqual(summary);

    const { json: mcpSummaryJson, isError: mcpSummaryError } = await callTool('crontick_stats_summary', {});
    expect(mcpSummaryError).toBe(false);
    expect(mcpSummaryJson as StatsSummary).toEqual(summary);

    const dashboard = await client.dashboardData({ runsLimit: 10 }) as DashboardPayload;
    expect(dashboard.stats).toEqual(summary);
    expect(dashboard.health.jobs).toEqual({ total: 1, enabled: 1 });
    expect(dashboard.health.runs).toEqual({ last24h: 1, failures24h: 0 });
    expect(dashboard.jobs.map((job) => job.alias)).toEqual([liveJobId]);
    expect(dashboard.runs.map((run) => ({ id: run.id, jobId: run.jobId, jobAlias: run.jobAlias }))).toEqual([
      { id: liveRunId, jobId: liveJob.id, jobAlias: liveJob.alias ?? null },
    ]);

    // Nothing of the deleted job is left on any surface.
    await expect(client.getRun(deletedRunId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await client.listRuns()).map((run) => run.id)).toEqual([liveRunId]);
    expect(await client.listRuns({ jobId: deletedJob.id })).toEqual([]);
    expect(await client.listRuns({ jobId: deletedJobId })).toEqual([]);
    const cliRuns = cli(['runs', 'list', '--json']);
    expect(cliRuns.status, cliRuns.stderr).toBe(0);
    expect((JSON.parse(cliRuns.stdout) as RunRecord[]).map((run) => run.id)).toEqual([liveRunId]);
    expect(cli(['runs', 'get', deletedRunId]).status).toBe(1);
    const { isError: mcpGetError } = await callTool('crontick_run_get', { id: deletedRunId });
    expect(mcpGetError).toBe(true);
    const outputResponse = await fetch(`${baseUrl}/api/runs/${deletedRunId}/output`);
    expect(outputResponse.status).toBe(404);
    const mcpRuns = await callTool('crontick_run_list', {});
    expect((mcpRuns.json as unknown as RunRecord[]).map((run) => run.id)).toEqual([liveRunId]);
    expect(existsSync(join(HOME, 'logs', `${deletedJob.id}.log`))).toBe(false);
    expect(existsSync(join(HOME, 'logs', `${liveJob.id}.log`))).toBe(true);

    expect(ORPHAN_RUN_ERROR_CODE).toBe('DAEMON_RESTART');
    expect(ORPHAN_RUN_ERROR_MESSAGE).toBe(
      'DAEMON_RESTART: run was canceled because the daemon restarted while it was queued or running',
    );
  }, 20_000);
});
