import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ORPHAN_RUN_ERROR_CODE, ORPHAN_RUN_ERROR_MESSAGE, createClient } from '../../src/index.js';

const CLI = resolve('dist', 'cli', 'index.js');
const MCP = resolve('dist', 'mcp', 'index.js');
const DAEMON_SCRIPT = resolve('dist', 'daemon', 'index.js');
const HOME = resolve('.crontick', 'stats-excludes-deleted-job-runs-ctd-014');

type StatsSummary = {
  totalJobs: number;
  enabledJobs: number;
  totalRuns: number;
  succeeded: number;
  failed: number;
  avgDurationMs: number | null;
};

type DashboardPayload = {
  health: {
    jobs: { total: number; enabled: number };
    runs: { last24h: number; failures24h: number };
  };
  stats: StatsSummary;
  jobs: Array<{ id: string }>;
  runs: Array<{ id: string; jobId: string }>;
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
}

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, '--json', ...args], {
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
    id,
    schedule: { kind: 'interval' as const, everySec: 3600 },
    action: {
      kind: 'exec' as const,
      command: process.execPath,
      args: ['-e', `console.log(${JSON.stringify(line)})`],
    },
  };
}

function dashboardAssertions(data: DashboardPayload): Pick<DashboardPayload, 'stats'> & { healthRuns: DashboardPayload['health']['runs']; jobIds: string[]; runIds: string[] } {
  return {
    stats: data.stats,
    healthRuns: data.health.runs,
    jobIds: data.jobs.map((job) => job.id),
    runIds: data.runs.map((run) => run.id),
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

describe('CTD-014 deleted-job aggregates', () => {
  it('excludes deleted-job history from live stats/dashboard views while preserving direct run access', async () => {
    const liveJobId = 'ctd-014-live-job';
    const deletedJobId = 'ctd-014-deleted-job';

    await client.createJob(jobDefinition(liveJobId, 'live-history'));
    await client.createJob(jobDefinition(deletedJobId, 'deleted-history'));

    const liveRunId = (await client.runNow(liveJobId) as { runId: string }).runId;
    await waitForTerminalRun(liveRunId);
    await delay(50);

    const deletedRunId = (await client.runNow(deletedJobId) as { runId: string }).runId;
    await waitForTerminalRun(deletedRunId);

    const beforeDelete = await client.statsSummary();
    expect(beforeDelete).toMatchObject({ totalJobs: 2, enabledJobs: 2, totalRuns: 2, succeeded: 2, failed: 0 });

    await client.deleteJob(deletedJobId);

    const summary = await client.statsSummary();
    expect(summary).toEqual({
      totalJobs: 1,
      enabledJobs: 1,
      totalRuns: 1,
      succeeded: 1,
      failed: 0,
      avgDurationMs: expect.any(Number),
    });

    const cliSummaryResult = cli(['stats', 'summary']);
    expect(cliSummaryResult.status, cliSummaryResult.stderr).toBe(0);
    expect(JSON.parse(cliSummaryResult.stdout) as StatsSummary).toEqual(summary);

    const { json: mcpSummaryJson, isError: mcpSummaryError } = await callTool('crontick_stats_summary', {});
    expect(mcpSummaryError).toBe(false);
    expect(mcpSummaryJson as StatsSummary).toEqual(summary);

    const dashboard = await client.dashboardData({ runsLimit: 10 }) as DashboardPayload;
    expect(dashboard.stats).toEqual(summary);
    expect(dashboard.health.jobs).toEqual({ total: 1, enabled: 1 });
    expect(dashboard.health.runs).toEqual({ last24h: 1, failures24h: 0 });
    expect(dashboard.jobs.map((job) => job.id)).toEqual([liveJobId]);
    expect(dashboard.runs.map((run) => ({ id: run.id, jobId: run.jobId }))).toEqual([{ id: liveRunId, jobId: liveJobId }]);

    const cliDashboardResult = cli(['dashboard', 'data', '--runs-limit', '10']);
    expect(cliDashboardResult.status, cliDashboardResult.stderr).toBe(0);
    const cliDashboard = JSON.parse(cliDashboardResult.stdout) as DashboardPayload;
    expect(dashboardAssertions(cliDashboard)).toEqual(dashboardAssertions(dashboard));

    const { json: mcpDashboardJson, isError: mcpDashboardError } = await callTool('crontick_dashboard_data', { runsLimit: 10 });
    expect(mcpDashboardError).toBe(false);
    expect(dashboardAssertions(mcpDashboardJson as DashboardPayload)).toEqual(dashboardAssertions(dashboard));

    const archivedRun = await client.getRun(deletedRunId) as RunRecord;
    expect(archivedRun).toMatchObject({ id: deletedRunId, jobId: deletedJobId, status: 'success', exitCode: 0 });

    const archivedLogs = await client.getLogs(deletedRunId);
    expect(archivedLogs.runId).toBe(deletedRunId);
    expect(archivedLogs.lines.some((line) => line.data.includes('deleted-history'))).toBe(true);

    expect(ORPHAN_RUN_ERROR_CODE).toBe('DAEMON_RESTART');
    expect(ORPHAN_RUN_ERROR_MESSAGE).toBe(
      'DAEMON_RESTART: run was canceled because the daemon restarted while it was queued or running',
    );
  }, 20_000);
});
