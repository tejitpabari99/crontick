import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatJobStats, formatLocalIso, formatRunDetail } from '../../src/run-format.js';
import type { RunRecord } from '../../src/client.js';
import { sampleJob, startApiHarness, type ApiHarness } from '../helpers/api-harness.js';

const CLI = resolve('dist/cli/index.js');

const run: RunRecord = {
  id: 'run-1', jobId: 'job-1', startedAt: Date.UTC(2026, 8, 29, 10, 0, 0), endedAt: Date.UTC(2026, 8, 29, 10, 0, 5),
  status: 'success', exitCode: 0, durationMs: 5000, pid: 42, outputTruncated: false, sessionId: 'sess-1', command: 'claude -p x',
  costUsd: 0.01, turns: 2, engineStatus: 'success', transcriptPath: '/t/sess-1.jsonl', logFile: '/logs/job-1.log',
};

describe('formatRunDetail', () => {
  it('prints labeled fields, transcript then log file, a blank line, then the cleaned result; Status once', () => {
    const text = formatRunDetail(run, { error: null, result: 'the answer', stderr: 'warn' });
    const lines = text.split('\n');
    expect(lines).toContain(`Started: ${formatLocalIso(run.startedAt)}`);
    expect(lines).toContain('Runner Session ID: sess-1');
    expect(text.match(/^Status:/gm)).toHaveLength(1);
    const transcript = lines.indexOf('Transcript: /t/sess-1.jsonl');
    expect(lines[transcript + 1]).toBe('Log file: /logs/job-1.log');
    expect(lines[transcript + 2]).toBe('');
    expect(lines[transcript + 3]).toBe('the answer');
    expect(text).toContain('[stderr] warn');
    expect(text).not.toMatch(/\b1[6-9]\d{11}\b/);
  });

  it('shows the error instead of stderr, falls back to the readable output, and notes disabled file logging', () => {
    const text = formatRunDetail({ ...run, logFile: null }, { error: 'boom', result: 'readable', stderr: 'noise' });
    expect(text).toContain('Log file: (file logging is disabled)');
    expect(text).toContain('Error: boom');
    expect(text).toContain('readable');
    expect(text).not.toContain('[stderr]');
  });
});

describe('formatJobStats', () => {
  it('converts lastRunAt to local ISO and labels totalTurns', () => {
    const out = formatJobStats({ jobId: 'j', succeeded: 1, failed: 0, canceled: 0, skipped: 0, lastStatus: 'success', lastRunAt: run.startedAt, avgDurationSec: 1, totalCostUsd: 0, totalTurns: 6 });
    expect(out['lastRunAt']).toBe(formatLocalIso(run.startedAt));
    expect(out['totalTurns (agent turns, summed over runs)']).toBe(6);
    expect(formatJobStats({ jobId: 'j', succeeded: 0, failed: 0, canceled: 0, skipped: 0, lastStatus: null, lastRunAt: null, avgDurationSec: null, totalCostUsd: 0, totalTurns: 0 })['lastRunAt']).toBeNull();
  });
});

describe('GET /api/stats/jobs/:id', () => {
  let h: ApiHarness | undefined;
  afterEach(async () => { await h?.close(); h = undefined; });

  it('counts every retained run, not just the latest 100', async () => {
    h = await startApiHarness('stats-all-runs');
    const created = await h.call('POST', '/api/jobs', sampleJob({ alias: 'many-runs' }));
    const id = created.data.id as string;
    h.store.setRunRetentionCap(500); // default cap is 100; the stats must follow the configured retention, not a hardcoded 100
    for (let i = 0; i < 130; i++) {
      const r = h.store.insertRun(id, 1_000 + i);
      h.store.updateRun(r.id, { status: 'success', turns: 2 });
    }
    const stats = await h.call('GET', '/api/stats/jobs/many-runs');
    expect(stats.data).not.toHaveProperty('totalRuns');
    expect(stats.data).toMatchObject({ succeeded: 130, totalTurns: 260, lastRunAt: 1_129 });
  });
});

describe('jobs schedule status', () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) {
      spawnSync(process.execPath, [CLI, 'daemon', 'stop'], { env: { ...process.env, CRONTICK_HOME: home } });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('prints status: enabled|disabled before the fire times; MCP/library payload has enabled', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'crontick-sched-')));
    homes.push(home);
    const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', env: { ...process.env, CRONTICK_HOME: home }, timeout: 30_000 });
    expect(cli(['jobs', 'new', '-n', 'sched-job', '-p', 'x', '--every', '1h']).status).toBe(0);
    let out = cli(['jobs', 'schedule', 'sched-job', '-n', '2']).stdout;
    expect(out).toContain('status: enabled');
    expect(out.indexOf('status: enabled')).toBeLessThan(out.indexOf('next:'));
    cli(['jobs', 'update', 'sched-job', '--disable']);
    out = cli(['jobs', 'schedule', 'sched-job']).stdout;
    expect(out).toContain('status: disabled');
    expect(out).not.toContain('enabled: ');
  }, 60_000);
});
