import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '../src/index.js';
import { tempScriptsDir } from '../src/paths.js';

const DAEMON_SCRIPT = resolve('dist', 'daemon', 'index.js');
const SCRATCH_ROOT = resolve('.crontick', 'temp-script-cleanup-ctd-017');
let home = '';
let env: NodeJS.ProcessEnv;
let client: ReturnType<typeof createClient> | undefined;

type RunRecord = {
  id: string;
  status: string;
  exitCode?: number;
};

type RunLogsPayload = {
  lines: Array<{ data: string }>;
};

function managedScriptsDir(): string {
  return tempScriptsDir(env);
}

function resetHome(): void {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, 'jobs'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
}

function readEntries(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, message: string, maxMs = 15_000): Promise<T> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function waitForTerminalRun(runId: string, maxMs = 15_000): Promise<RunRecord> {
  return waitFor(async () => {
    const run = await client!.getRun(runId) as RunRecord;
    if (run.status === 'queued' || run.status === 'running') return undefined;
    return run;
  }, `terminal run ${runId}`, maxMs);
}

beforeEach(() => {
  home = join(SCRATCH_ROOT, randomUUID());
  env = {
    ...process.env,
    CRONTICK_HOME: home,
  };
  client = createClient({ env, daemonScript: DAEMON_SCRIPT, startupTimeoutMs: 15_000 });
  resetHome();
});

afterEach(async () => {
  try { await client?.daemonStop(); } catch { /* ignore */ }
  rmSync(home, { recursive: true, force: true });
  home = '';
  client = undefined;
});

describe('CTD-017 temp script cleanup', () => {
  it('uses CRONTICK_HOME-managed temp scripts and cleans them up after the run', async () => {
    expect(managedScriptsDir()).toBe(join(home, 'tmp', 'scripts'));

    const daemon = await client!.ensure();
    expect(daemon.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    await client!.createJob({
      id: 'ctd-017-script-job',
      schedule: { kind: 'interval', everySec: 3600 },
      action: {
        kind: 'script',
        shell: 'cmd',
        script: '@echo off\r\nping -n 3 127.0.0.1 >nul\r\necho ctd-017 managed temp cleanup\r\n',
      },
      overlap: 'skip',
      retry: { max: 0, backoffSec: 1 },
    });

    const runId = (await client!.runNow('ctd-017-script-job') as { runId: string }).runId;
    const activeManagedFiles = await waitFor(async () => {
      const run = await client!.getRun(runId) as RunRecord;
      if (run.status !== 'running') return undefined;
      const files = readEntries(managedScriptsDir());
      return files.length > 0 ? files : undefined;
    }, 'managed temp script files');

    expect(activeManagedFiles.every((name) => name.endsWith('.bat'))).toBe(true);

    const run = await waitForTerminalRun(runId);
    expect(run).toMatchObject({ status: 'success', exitCode: 0 });
    await waitFor(() => readEntries(managedScriptsDir()).length === 0 ? true : undefined, 'managed temp script cleanup');

    const logs = await client!.getLogs(runId) as RunLogsPayload;
    expect(logs.lines.some((line) => line.data.includes('ctd-017 managed temp cleanup'))).toBe(true);
  }, 20_000);
});
