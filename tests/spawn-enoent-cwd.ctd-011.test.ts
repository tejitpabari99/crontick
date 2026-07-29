import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { Runner } from '../src/daemon/runner.js';
import { Store } from '../src/daemon/store.js';
import type { Job } from '../src/schemas/job.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'crontick-runner-cwd-'));
}

function makeStore(dir: string): Store {
  const s = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
  s.open();
  return s;
}

function execJob(id: string, cwd: string): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: { kind: 'exec', command: process.execPath, args: ['--version'], cwd },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
  };
}

function scriptJob(id: string, cwd: string): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: {
      kind: 'script',
      script: platform() === 'win32' ? '@echo hello\r\n' : 'printf "hello\\n"\n',
      shell: platform() === 'win32' ? 'cmd' : 'bash',
      cwd,
    },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
  };
}

function promptJob(id: string, cwd: string): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: {
      kind: 'prompt',
      prompt: 'hello',
      engine: 'copilot',
      args: [],
      reuseSession: false,
      cwd,
    },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
  };
}

interface SpawnCall {
  cmd: string;
  args: string[];
  opts?: SpawnOptions;
}

function fakeSpawnSuccess() {
  const calls: SpawnCall[] = [];
  const spawnFn = (cmd: string, args?: readonly string[], opts?: SpawnOptions): ChildProcess => {
    calls.push({ cmd, args: [...(args ?? [])], opts });
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 12345,
      kill: () => true,
    });
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };
  return { calls, spawnFn };
}

function fakeSpawnError(error: NodeJS.ErrnoException) {
  const calls: SpawnCall[] = [];
  const spawnFn = (cmd: string, args?: readonly string[], opts?: SpawnOptions): ChildProcess => {
    calls.push({ cmd, args: [...(args ?? [])], opts });
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 12345,
      kill: () => true,
    });
    queueMicrotask(() => child.emit('error', error));
    return child;
  };
  return { calls, spawnFn };
}

describe('Runner missing cwd preflight (CTD-011)', () => {
  let dir: string;
  let store: Store;
  let previousHome: string | undefined;

  beforeEach(() => {
    dir = makeTmpDir();
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    previousHome = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    store = makeStore(dir);
  });

  afterEach(() => {
    store.close();
    if (previousHome === undefined) delete process.env['CRONTICK_HOME'];
    else process.env['CRONTICK_HOME'] = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });

  async function expectMissingCwdFailure(job: Job): Promise<void> {
    const fake = fakeSpawnSuccess();
    const runner = new Runner(fake.spawnFn as never);
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(fake.calls).toHaveLength(0);
    expect(store.getRun(run.id)).toMatchObject({
      status: 'failed',
      error: `ACTION_CWD_INVALID: ${job.action.kind} action cwd does not exist: "${job.action.cwd}". Update action.cwd to an existing directory before the next run.`,
    });
    expect(store.getRun(run.id)?.error).not.toContain('spawn');
    expect(store.getRun(run.id)?.error).not.toContain('ENOENT');
  }

  it('fails exec jobs with an explicit missing-cwd error and terminal failed status before spawn', async () => {
    await expectMissingCwdFailure(execJob('exec-missing-cwd', join(dir, 'missing-exec-cwd')));
  });

  it('fails script jobs with the same explicit missing-cwd error and terminal failed status before spawn', async () => {
    await expectMissingCwdFailure(scriptJob('script-missing-cwd', join(dir, 'missing-script-cwd')));
  });

  it('fails prompt jobs with the same cwd-focused error instead of prompt-engine PATH guidance', async () => {
    const job = promptJob('prompt-missing-cwd', join(dir, 'missing-prompt-cwd'));
    const fake = fakeSpawnSuccess();
    const runner = new Runner(fake.spawnFn as never);
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(fake.calls).toHaveLength(0);
    expect(store.getRun(run.id)).toMatchObject({
      status: 'failed',
      error: `ACTION_CWD_INVALID: prompt action cwd does not exist: "${job.action.cwd}". Update action.cwd to an existing directory before the next run.`,
    });
    expect(store.getRun(run.id)?.error).not.toContain('was not found on PATH');
  });

  it('keeps the existing prompt-engine binary-not-found guidance when cwd is valid', async () => {
    const error = Object.assign(new Error('spawn copilot ENOENT'), { code: 'ENOENT' });
    const fake = fakeSpawnError(error);
    const runner = new Runner(fake.spawnFn as never);
    const job = promptJob('prompt-missing-binary', dir);
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].opts?.cwd).toBe(dir);
    expect(store.getRun(run.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Prompt engine "copilot" command "copilot" was not found on PATH'),
    });
  });
});
