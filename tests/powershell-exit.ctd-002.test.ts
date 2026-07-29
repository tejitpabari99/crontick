import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { platform, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Runner } from '../src/daemon/runner.js';
import { Store } from '../src/daemon/store.js';
import type { Job } from '../src/schemas/job.js';

const pwshProbe = platform() === 'win32'
  ? spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore' })
  : undefined;
const hasWindowsPwsh = platform() === 'win32' && !pwshProbe?.error && pwshProbe?.status === 0;

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crontick-pwsh-exit-'));
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

function makeStore(dir: string): Store {
  const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
  store.open();
  return store;
}

function scriptJob(id: string, script: string): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: {
      kind: 'script',
      shell: 'pwsh',
      script,
    },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 0 },
  };
}

describe.runIf(hasWindowsPwsh)('CTD-002 PowerShell exit semantics', () => {
  let dir: string;
  let store: Store;
  let runner: Runner;
  let previousHome: string | undefined;
  let sequence = 0;

  beforeEach(() => {
    dir = makeTmpDir();
    previousHome = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    store = makeStore(dir);
    runner = new Runner();
  });

  afterEach(() => {
    store.close();
    if (previousHome === undefined) delete process.env['CRONTICK_HOME'];
    else process.env['CRONTICK_HOME'] = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });

  async function runScript(script: string): Promise<{ run: NonNullable<ReturnType<Store['getRun']>>; logs: string }> {
    const job = scriptJob(`pwsh-exit-${++sequence}`, script);
    const run = store.insertRun(job.id);
    await runner.run(job, run.id, store);
    return {
      run: store.getRun(run.id)!,
      logs: store.getLogs(run.id).map((entry) => entry.chunk.toString('utf-8')).join(''),
    };
  }

  it('reports success for a clean PowerShell script exit', async () => {
    const result = await runScript("Write-Output 'clean exit'");

    expect(result.run).toMatchObject({
      status: 'success',
      exitCode: 0,
    });
    expect(result.logs).toContain('clean exit');
  });

  it('preserves an explicit non-zero exit code', async () => {
    const result = await runScript("Write-Output 'before explicit exit'\nexit 7");

    expect(result.run).toMatchObject({
      status: 'failed',
      exitCode: 7,
    });
    expect(result.logs).toContain('before explicit exit');
  });

  it('fails uncaught terminating errors with a non-zero exit code', async () => {
    const result = await runScript("throw 'boom from throw'");

    expect(result.run).toMatchObject({
      status: 'failed',
      exitCode: 1,
    });
    expect(result.logs).toContain('boom from throw');
  });

  it('fails command-not-found with a non-zero exit code', async () => {
    const result = await runScript('DefinitelyMissingCrontickCommand');

    expect(result.run).toMatchObject({
      status: 'failed',
      exitCode: 1,
    });
    expect(result.logs).toContain('DefinitelyMissingCrontickCommand');
  });

  it('fails missing-module errors with a non-zero exit code', async () => {
    const result = await runScript("Import-Module CrontickDefinitelyMissingModule");

    expect(result.run).toMatchObject({
      status: 'failed',
      exitCode: 1,
    });
    expect(result.logs).toContain('CrontickDefinitelyMissingModule');
  });

  it('promotes non-terminating PowerShell errors to a non-zero exit code', async () => {
    const result = await runScript("Write-Error 'non-terminating failure'");

    expect(result.run).toMatchObject({
      status: 'failed',
      exitCode: 1,
    });
    expect(result.logs).toContain('non-terminating failure');
  });
});
