import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '../src/index.js';
import { legacyScriptTempDir } from '../src/daemon/ensure.js';
import { tempScriptsDir } from '../src/paths.js';

const DAEMON_SCRIPT = resolve('dist', 'daemon', 'index.js');
const HOME = String.raw`Q:\Rough\crontick-qa\state\devfix2\temp-script-cleanup-ctd-017`;
const TEMP_ROOT = join(HOME, 'legacy-os-temp');
const env = {
  ...process.env,
  CRONTICK_HOME: HOME,
  TEMP: TEMP_ROOT,
  TMP: TEMP_ROOT,
};
const MANAGED_SCRIPTS_DIR = tempScriptsDir(env);
const LEGACY_SCRIPTS_DIR = legacyScriptTempDir(env);
const client = createClient({ env, daemonScript: DAEMON_SCRIPT, startupTimeoutMs: 15_000 });

type RunRecord = {
  id: string;
  status: string;
  exitCode?: number;
};

type RunLogsPayload = {
  lines: Array<{ data: string }>;
};

function resetHome(): void {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(HOME, 'jobs'), { recursive: true });
  mkdirSync(join(HOME, 'logs'), { recursive: true });
  mkdirSync(TEMP_ROOT, { recursive: true });
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
    const run = await client.getRun(runId) as RunRecord;
    if (run.status === 'queued' || run.status === 'running') return undefined;
    return run;
  }, `terminal run ${runId}`, maxMs);
}

beforeEach(() => {
  resetHome();
});

afterEach(async () => {
  try { await client.daemonStop(); } catch { /* ignore */ }
  rmSync(HOME, { recursive: true, force: true });
});

describe('CTD-017 temp script cleanup', () => {
  it('uses CRONTICK_HOME-managed temp scripts and sweeps legacy OS-temp leftovers on daemon startup', async () => {
    const legacySeedFile = join(LEGACY_SCRIPTS_DIR, 'legacy-leftover.cmd');
    mkdirSync(LEGACY_SCRIPTS_DIR, { recursive: true });
    writeFileSync(legacySeedFile, '@echo off\r\necho legacy leftover\r\n', 'utf8');

    const daemon = await client.ensure();
    expect(daemon.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await waitFor(() => existsSync(legacySeedFile) ? undefined : true, 'legacy startup sweep');
    expect(readEntries(LEGACY_SCRIPTS_DIR)).toEqual([]);

    await client.createJob({
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

    const runId = (await client.runNow('ctd-017-script-job') as { runId: string }).runId;
    const activeManagedFiles = await waitFor(async () => {
      const run = await client.getRun(runId) as RunRecord;
      if (run.status !== 'running') return undefined;
      const files = readEntries(MANAGED_SCRIPTS_DIR);
      return files.length > 0 ? files : undefined;
    }, 'managed temp script files');

    expect(activeManagedFiles.every((name) => name.endsWith('.bat'))).toBe(true);
    expect(readEntries(LEGACY_SCRIPTS_DIR)).toEqual([]);

    const run = await waitForTerminalRun(runId);
    expect(run).toMatchObject({ status: 'success', exitCode: 0 });
    await waitFor(() => readEntries(MANAGED_SCRIPTS_DIR).length === 0 ? true : undefined, 'managed temp script cleanup');
    expect(readEntries(LEGACY_SCRIPTS_DIR)).toEqual([]);

    const logs = await client.getLogs(runId) as RunLogsPayload;
    expect(logs.lines.some((line) => line.data.includes('ctd-017 managed temp cleanup'))).toBe(true);
  }, 20_000);
});
