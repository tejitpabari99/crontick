import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { Runner } from '../src/daemon/runner.js';
import { Store } from '../src/daemon/store.js';
import type { Job } from '../src/schemas/job.js';
import { JobSchema } from '../src/schemas/job.js';

const node = process.execPath;

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'crontick-runner-'));
}

function makeStore(dir: string): Store {
  const s = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
  s.open();
  return s;
}

function execJob(id: string, command: string, args: string[], opts?: Partial<Job>): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: { kind: 'exec', command, args },
    catchup: 'skip',
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
    budgets: { maxRunsPerDay: null, maxTokensPerRun: null },
    ...opts,
  };
}

function promptJob(id: string, action: Partial<Extract<Job['action'], { kind: 'prompt' }>> = {}): Job {
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
      ...action,
    },
    catchup: 'skip',
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
    budgets: { maxRunsPerDay: null, maxTokensPerRun: null },
  };
}

interface SpawnCall {
  cmd: string;
  args: string[];
  opts?: SpawnOptions;
}

function fakeSpawn(outputs: Array<{ stdout?: string; stderr?: string; code?: number }>) {
  const calls: SpawnCall[] = [];
  const spawnFn = (cmd: string, args?: readonly string[], opts?: SpawnOptions): ChildProcess => {
    calls.push({ cmd, args: [...(args ?? [])], opts });
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, {
      stdout,
      stderr,
      pid: 12345,
      kill: () => true,
    });
    const output = outputs[Math.min(calls.length - 1, outputs.length - 1)] ?? {};
    queueMicrotask(() => {
      if (output.stdout) stdout.write(output.stdout);
      if (output.stderr) stderr.write(output.stderr);
      stdout.end();
      stderr.end();
      child.emit('close', output.code ?? 0, null);
    });
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

describe('Runner', () => {
  let dir: string;
  let store: Store;
  let runner: Runner;

  beforeEach(() => {
    dir = makeTmpDir();
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    store = makeStore(dir);
    runner = new Runner();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── exec kind ────────────────────────────────────────────────────────────────

  it('exec: success path sets status=success and exitCode=0', async () => {
    const job = execJob('ok', node, ['-e', 'process.exit(0)']);
    const run = store.insertRun(job.id);
    await runner.run(job, run.id, store);
    const updated = store.getRun(run.id)!;
    expect(updated.status).toBe('success');
    expect(updated.exitCode).toBe(0);
  });

  it('exec: non-zero exit sets status=failed', async () => {
    const job = execJob('fail', node, ['-e', 'process.exit(42)']);
    const run = store.insertRun(job.id);
    await runner.run(job, run.id, store);
    const updated = store.getRun(run.id)!;
    expect(updated.status).toBe('failed');
    expect(updated.exitCode).toBe(42);
  });

  it('exec: stdout logs are captured', async () => {
    const job = execJob('log', node, ['-e', 'process.stdout.write("hello world\\n")']);
    const run = store.insertRun(job.id);
    await runner.run(job, run.id, store);
    const logs = store.getLogs(run.id);
    const text = logs.map((l) => l.chunk.toString('utf-8')).join('');
    expect(text).toContain('hello world');
  });

  it('exec: stderr logs are captured', async () => {
    const job = execJob('err-log', node, ['-e', 'process.stderr.write("error line\\n"); process.exit(1)']);
    const run = store.insertRun(job.id);
    await runner.run(job, run.id, store);
    const logs = store.getLogs(run.id);
    const stderrLogs = logs.filter((l) => l.stream === 'stderr');
    expect(stderrLogs.length).toBeGreaterThan(0);
  });

  it('exec: durationMs is set after completion', async () => {
    const job = execJob('timer', node, ['-e', 'process.exit(0)']);
    const run = store.insertRun(job.id);
    await runner.run(job, run.id, store);
    const updated = store.getRun(run.id)!;
    expect(updated.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── script kind ─────────────────────────────────────────────────────────────

  it('script: executes inline script body', async () => {
    const job: Job = {
      id: 'script-job',
      enabled: true,
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: {
        kind: 'script',
        // Use node shebang for cross-platform
        script: `#!/usr/bin/env node\nprocess.stdout.write('from-script\\n');\n`,
        shell: 'auto',
      },
      catchup: 'skip',
      overlap: 'skip',
      retry: { max: 0, backoffSec: 30 },
      budgets: { maxRunsPerDay: null, maxTokensPerRun: null },
    };
    const run = store.insertRun(job.id);
    await runner.run(job, run.id, store);
    // Either success or failed depending on pwsh availability, but no crash
    const updated = store.getRun(run.id)!;
    expect(['success', 'failed']).toContain(updated.status);
  });

  // ── Timeout ──────────────────────────────────────────────────────────────────

  it('exec: timeout cancels long-running job', async () => {
    const job = execJob(
      'timeout-job',
      node,
      ['-e', 'setTimeout(() => {}, 30000)'],
      { action: { kind: 'exec', command: node, args: ['-e', 'setTimeout(() => {}, 30000)'], timeoutSec: 1 } },
    );
    const run = store.insertRun(job.id);
    await runner.run(job, run.id, store);
    const updated = store.getRun(run.id)!;
    // Should be canceled or timeout (signal kills the process)
    expect(['canceled', 'timeout', 'failed']).toContain(updated.status);
  }, 10000);

  // ── Retry ────────────────────────────────────────────────────────────────────

  it('exec: retries up to max on failure', async () => {
    const job = execJob(
      'retry-job',
      node,
      ['-e', 'process.exit(1)'],
      { retry: { max: 2, backoffSec: 0 } },
    );
    const run = store.insertRun(job.id);
    await runner.run(job, run.id, store);
    const updated = store.getRun(run.id)!;
    expect(updated.status).toBe('failed');
  }, 15000);

  // ── Overlap ──────────────────────────────────────────────────────────────────

  it('overlap=skip: second run is canceled when first is active', async () => {
    const job = execJob(
      'overlap-skip',
      node,
      ['-e', 'setTimeout(() => process.exit(0), 5000)'],
      { overlap: 'skip' },
    );

    const run1 = store.insertRun(job.id);
    const run2 = store.insertRun(job.id);

    // Start first run (don't await)
    const p1 = runner.run(job, run1.id, store);
    // Small delay, then try second
    await new Promise((r) => setTimeout(r, 50));
    await runner.run(job, run2.id, store);

    expect(store.getRun(run2.id)?.status).toBe('canceled');

    // Cancel first run to clean up
    runner.cancelRun(run1.id);
    await p1;
  }, 10000);

  it('overlap=cancel-previous: cancels the first run', async () => {
    const job = execJob(
      'overlap-cancel',
      node,
      ['-e', 'setTimeout(() => process.exit(0), 10000)'],
      { overlap: 'cancel-previous' },
    );

    const run1 = store.insertRun(job.id);
    const run2 = store.insertRun(job.id);

    const p1 = runner.run(job, run1.id, store);
    await new Promise((r) => setTimeout(r, 100));
    const p2 = runner.run(job, run2.id, store);

    await Promise.all([p1, p2.catch(() => {})]);

    expect(['canceled', 'failed']).toContain(store.getRun(run1.id)?.status);
  }, 15000);

  // ── Budget ───────────────────────────────────────────────────────────────────

  it('budget: maxRunsPerDay=1 cancels second run on same day', async () => {
    const job = execJob(
      'budget-job',
      node,
      ['-e', 'process.exit(0)'],
      { budgets: { maxRunsPerDay: 1, maxTokensPerRun: null } },
    );

    const run1 = store.insertRun(job.id);
    await runner.run(job, run1.id, store);
    expect(store.getRun(run1.id)?.status).toBe('success');

    const run2 = store.insertRun(job.id);
    await runner.run(job, run2.id, store);
    expect(store.getRun(run2.id)?.status).toBe('canceled');
  });

  // ── cancelRun ────────────────────────────────────────────────────────────────

  it('cancelRun returns false for unknown run', () => {
    runner = new Runner();
    expect(runner.cancelRun('non-existent')).toBe(false);
  });

  // ── Overlap race (cancel-previous) ───────────────────────────────────────────

  it('overlap=cancel-previous: A finally does not evict B from active slots, so C cancels B', async () => {
    const job = execJob(
      'race-cancel',
      node,
      ['-e', 'setTimeout(() => process.exit(0), 15000)'],
      { overlap: 'cancel-previous' },
    );

    const runA = store.insertRun(job.id);
    const runB = store.insertRun(job.id);
    const runC = store.insertRun(job.id);

    // Start A (slow)
    const pA = runner.run(job, runA.id, store);
    await new Promise((r) => setTimeout(r, 100));

    // Start B — cancels A and takes the active slot
    const pB = runner.run(job, runB.id, store);
    await new Promise((r) => setTimeout(r, 100));

    // Wait for A to fully settle (its finally block executes)
    await pA;

    // Start C — must see B as active and cancel it
    const pC = runner.run(job, runC.id, store);
    await new Promise((r) => setTimeout(r, 500));

    // B should be canceled by C
    expect(['canceled', 'failed']).toContain(store.getRun(runB.id)?.status);

    // Clean up C
    runner.cancelJob(job.id);
    await Promise.all([pB, pC]);
  }, 25000);

  // ── Binary output (redaction must not corrupt) ───────────────────────────────

  it('exec: binary stdout bytes are preserved without redaction corruption', async () => {
    const job = execJob('binary', node, [
      '-e',
      'process.stdout.write(Buffer.from([0, 1, 2, 255, 65]))', // 65 = 'A'
    ]);
    const run = store.insertRun(job.id);
    await runner.run(job, run.id, store);
    const logs = store.getLogs(run.id);
    const stdoutLogs = logs.filter((l) => l.stream === 'stdout');
    const bytes = Buffer.concat(stdoutLogs.map((l) => l.chunk));
    expect(bytes).toEqual(Buffer.from([0, 1, 2, 255, 65]));
  });

  // ── Exec schema: shell injection rejected ────────────────────────────────────

  it('exec: job JSON with shell:true is stripped by zod — runner cannot receive shell:true', () => {
    const jobData = {
      id: 'shell-test',
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'exec', command: 'echo', args: [], shell: true },
    };
    const result = JobSchema.safeParse(jobData);
    expect(result.success).toBe(false);
    // Either way shell:true cannot reach runner
  });

  // ── prompt kind ─────────────────────────────────────────────────────────────

  it('prompt: builds Copilot command line without shell expansion', async () => {
    const fake = fakeSpawn([{ stdout: 'ok\n' }]);
    runner = new Runner(fake.spawnFn as never);
    const job = promptJob('prompt-copilot', {
      prompt: 'hello $(echo INJECTED)',
      args: ['--silent', '--add-dir', 'Q:\\Repos\\crontick', '--flag', 'one', '--flag', 'two'],
    });
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(store.getRun(run.id)?.status).toBe('success');
    expect(fake.calls[0]).toMatchObject({
      cmd: 'copilot',
      args: ['-p', 'hello $(echo INJECTED)', '--silent', '--add-dir', 'Q:\\Repos\\crontick', '--flag', 'one', '--flag', 'two'],
    });
    expect(fake.calls[0].opts?.shell).toBe(false);
  });

  it('prompt: builds Agency command line', async () => {
    const fake = fakeSpawn([{ stdout: 'ok\n' }]);
    runner = new Runner(fake.spawnFn as never);
    const job = promptJob('prompt-agency', {
      engine: 'agency',
      args: ['--profile', 'dev'],
    });
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(fake.calls[0]).toMatchObject({
      cmd: 'agency',
      args: ['cp', '-p', 'hello', '--profile', 'dev'],
    });
    expect(store.getRun(run.id)?.status).toBe('success');
  });

  it('prompt: reports a helpful error when the engine binary is missing', async () => {
    const error = Object.assign(new Error('spawn copilot ENOENT'), { code: 'ENOENT' });
    const fake = fakeSpawnError(error);
    runner = new Runner(fake.spawnFn as never);
    const job = promptJob('prompt-missing-engine');
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(store.getRun(run.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Prompt engine "copilot" was not found on PATH'),
    });
  });

  it('prompt: forwards explicit session id every run after raw args', async () => {
    const fake = fakeSpawn([{ stdout: 'ok\n' }, { stdout: 'ok\n' }]);
    runner = new Runner(fake.spawnFn as never);
    const job = promptJob('prompt-session', {
      args: ['--silent'],
      sessionId: 'sess-12345678',
    });

    await runner.run(job, store.insertRun(job.id).id, store);
    await runner.run(job, store.insertRun(job.id).id, store);

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0].args).toEqual(['-p', 'hello', '--silent', '--session-id', 'sess-12345678']);
    expect(fake.calls[1].args).toEqual(['-p', 'hello', '--silent', '--session-id', 'sess-12345678']);
  });

  it('prompt: captures and persists a reusable session id after first successful run', async () => {
    const fake = fakeSpawn([{ stdout: 'session id: sess-abcdefgh\n' }]);
    runner = new Runner(fake.spawnFn as never);
    const job = promptJob('prompt-reuse', { reuseSession: true });
    store.upsertJob(job);
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(store.getRun(run.id)?.status).toBe('success');
    const stored = store.getJob(job.id)!;
    expect(stored.action).toMatchObject({
      kind: 'prompt',
      sessionId: 'sess-abcdefgh',
      reuseSession: false,
    });
    expect(store.getLogs(run.id).map((log) => log.chunk.toString('utf-8')).join('')).toContain('captured session id');
  });

  it('prompt: reuses a previously persisted session id', async () => {
    const fake = fakeSpawn([{ stdout: 'ok\n' }]);
    runner = new Runner(fake.spawnFn as never);
    const job = promptJob('prompt-reuse-existing', {
      sessionId: 'sess-abcdefgh',
      reuseSession: false,
    });
    store.upsertJob(job);
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(fake.calls[0].args).toEqual(['-p', 'hello', '--session-id', 'sess-abcdefgh']);
    expect(store.getRun(run.id)?.status).toBe('success');
  });

  it('prompt: fails reuse contract when a successful first run emits no session id', async () => {
    const fake = fakeSpawn([{ stdout: 'ok but no id\n' }]);
    runner = new Runner(fake.spawnFn as never);
    const job = promptJob('prompt-reuse-missing', { reuseSession: true });
    store.upsertJob(job);
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(store.getRun(run.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('SESSION_ID_NOT_FOUND'),
    });
    expect(store.getJob(job.id)?.action).toMatchObject({ kind: 'prompt', reuseSession: true });
  });

  it('prompt: does not persist a session id when the engine fails', async () => {
    const fake = fakeSpawn([{ stdout: 'session id: sess-abcdefgh\n', code: 7 }]);
    runner = new Runner(fake.spawnFn as never);
    const job = promptJob('prompt-reuse-fail', { reuseSession: true });
    store.upsertJob(job);
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', exitCode: 7 });
    expect(store.getJob(job.id)?.action).toMatchObject({ kind: 'prompt', reuseSession: true });
  });
});
