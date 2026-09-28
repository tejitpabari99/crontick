import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import { Runner, truncationMarker, ADOPTED_RUN_EXITED_MESSAGE, truncateToUtf8Boundary } from '../../src/daemon/runner.js';
import { DEFAULT_MAX_OUTPUT_BYTES_PER_RUN } from '../../src/constants/retention.js';
import { isProcessAlive } from '../../src/process-liveness.js';
import { Store, RunImportSchema } from '../../src/daemon/store.js';
import type { Job } from '../../src/schemas/job.js';
import { JobSchema } from '../../src/schemas/job.js';
import { FAKE_ENGINE_CONFIG, FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';

const node = process.execPath;

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'crontick-runner-'));
}

function makeStore(dir: string): Store {
  const s = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
  s.open();
  return s;
}

/**
 * Builds a job whose prompt action resolves (via config, see
 * writeFakeEngineConfig) to `node -e <code>`, so the runner really spawns a
 * process running `code` -- this is what `exec`-kind fixtures did before
 * crontick became prompt-only (see docs/decisions/0002-prompt-only-jobs-and-engine-adapters.md).
 * Kept call-compatible with the old `execJob(id, node, ['-e', code, ...extraArgs])`
 * shape used throughout this file: `command` is unused (always `node`
 * already), and `args` is `['-e', code, ...extraArgs]`.
 */
function execJob(id: string, _command: string, args: string[], opts?: Partial<Job>): Job {
  const code = args[0] === '-e' ? (args[1] ?? '') : args.join(' ');
  const extraArgs = args[0] === '-e' ? args.slice(2) : [];
  return {
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: { kind: 'prompt', prompt: code, engine: FAKE_ENGINE_NAME, args: extraArgs, reuseSession: false },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
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
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
  };
}

interface SpawnCall {
  cmd: string;
  args: string[];
  opts?: SpawnOptions;
}

function fakeSpawn(outputs: Array<{ stdout?: string; stderr?: string; code?: number; beforeClose?: () => void }>) {
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
      output.beforeClose?.();
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
  let previousHome: string | undefined;

  beforeEach(() => {
    dir = makeTmpDir();
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    previousHome = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    // Keep these raw-engine fixtures independent of the built-in Claude adapter.
    writeFakeEngineConfig(dir, { engines: {
      [FAKE_ENGINE_NAME]: FAKE_ENGINE_CONFIG,
      copilot: { command: 'copilot', args: ['--allow-all-tools', '-p'], env: {}, type: 'raw' },
    } });
    store = makeStore(dir);
    runner = new Runner();
  });

  afterEach(() => {
    store.close();
    if (previousHome === undefined) delete process.env['CRONTICK_HOME'];
    else process.env['CRONTICK_HOME'] = previousHome;
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

  // ── Timeout ──────────────────────────────────────────────────────────────────

  it('exec: timeout cancels long-running job', async () => {
    const job = execJob(
      'timeout-job',
      node,
      ['-e', 'setTimeout(() => {}, 30000)'],
      { action: { kind: 'prompt', prompt: 'setTimeout(() => {}, 30000)', engine: FAKE_ENGINE_NAME, args: [], reuseSession: false, timeoutSec: 1 } },
    );
    const run = store.insertRun(job.id);
    await runner.run(job, run.id, store);
    const updated = store.getRun(run.id)!;
    // L-timeout fix: Node's spawn(..., {timeout}) kills with plain SIGTERM and
    // never emits ETIMEDOUT, so before the fix this was always recorded as
    // 'canceled' (indistinguishable from a user cancellation). Must be
    // exactly 'timeout' — not a broad accept-set, which is what hid the bug.
    expect(updated.status).toBe('timeout');
    expect(updated.error).toMatch(/timeoutSec/);
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

  it('overlap=skip: second run is skipped when first is active', async () => {
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

    expect(store.getRun(run2.id)).toMatchObject({ status: 'skipped', error: 'overlap=skip: another run is already active' });
    expect(store.getRun(run2.id)?.pid).toBeUndefined();
    expect(RunImportSchema.safeParse(store.getRun(run2.id)).success).toBe(true);
    expect(store.listRuns({ jobId: job.id, status: 'skipped' }).map((run) => run.id)).toContain(run2.id);

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

  // ── Prompt schema: shell injection rejected ──────────────────────────────────

  it('prompt: job JSON with an injected shell:true is rejected by the strict schema — runner cannot receive shell:true', () => {
    const jobData = {
      id: 'shell-test',
      schedule: { kind: 'cron', cron: '* * * * *' },
      action: { kind: 'prompt', prompt: 'hello', shell: true },
    };
    const result = JobSchema.safeParse(jobData);
    expect(result.success).toBe(false);
    // No action shape can smuggle shell:true through to the runner, which
    // always spawns with shell:false regardless.
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
      args: [
        '--allow-all-tools',
        '-p',
        'hello $(echo INJECTED)',
        '--silent',
        '--add-dir',
        'Q:\\Repos\\crontick',
        '--flag',
        'one',
        '--flag',
        'two',
      ],
    });
    expect(fake.calls[0].opts?.shell).toBe(false);
  });

  it('prompt: passes leading-dash prompts as a single argv value', async () => {
    const fake = fakeSpawn([{ stdout: 'ok\n' }]);
    runner = new Runner(fake.spawnFn as never);
    const job = promptJob('prompt-leading-dash', { prompt: '- summarize this' });
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(fake.calls[0].args[2]).toBe('- summarize this');
    expect(store.getRun(run.id)?.status).toBe('success');
  });

  it('prompt: builds Agency command line', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      defaultEngine: 'copilot',
      engines: {
        copilot: { command: 'copilot', args: [] },
        agency: { command: 'agency', args: ['cp'] },
      },
    }), 'utf-8');
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
      args: ['cp', 'hello', '--profile', 'dev'],
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
      error: expect.stringContaining('Prompt engine "copilot" command "copilot" was not found on PATH'),
    });
  });

  it('prompt: real spawn ENOENT for a genuinely missing engine binary produces the same actionable error (integration-level)', async () => {
    // No injected spawnFn here — this exercises the real child_process.spawn
    // ENOENT path (fakeSpawnError above only simulates it), matching the
    // convention that non-fake runner.test.ts tests already spawn real
    // processes (e.g. "exec: success path" above).
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      defaultEngine: 'nonexistent-engine-xyz',
      engines: {
        'nonexistent-engine-xyz': { command: 'crontick-test-nonexistent-engine-binary-xyz', args: [] },
      },
    }), 'utf-8');
    runner = new Runner(); // real spawn
    const job = promptJob('prompt-real-enoent', { engine: 'nonexistent-engine-xyz' });
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(store.getRun(run.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('nonexistent-engine-xyz'),
    });
    expect(store.getRun(run.id)?.error).toContain('was not found on PATH');
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
    expect(fake.calls[0].args).toEqual(['--allow-all-tools', '-p', 'hello', '--silent', '--session-id=sess-12345678']);
    expect(fake.calls[1].args).toEqual(['--allow-all-tools', '-p', 'hello', '--silent', '--session-id=sess-12345678']);
    expect(fake.calls[0].opts?.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('prompt: explicit session id wins over reuseSession and logs a notice', async () => {
    const fake = fakeSpawn([{ stdout: 'ok\n' }]);
    runner = new Runner(fake.spawnFn as never);
    const job = promptJob('prompt-session-precedence', {
      sessionId: 'sess-12345678',
      reuseSession: true,
    });
    store.upsertJob(job);
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(fake.calls[0].args).toEqual(['--allow-all-tools', '-p', 'hello', '--session-id=sess-12345678']);
    expect(store.getJob(job.id)?.action).toMatchObject({
      kind: 'prompt',
      sessionId: 'sess-12345678',
      reuseSession: false,
    });
    expect(store.getLogs(run.id).map((log) => log.chunk.toString('utf-8')).join('')).not.toContain('captured session id');
  });

  it('prompt: reuseSession-ignored notice is written to the crontick stream, never the engine stream', async () => {
    const fake = fakeSpawn([{ stdout: 'ok\n' }]);
    runner = new Runner(fake.spawnFn as never);
    // A job carrying both an explicit sessionId and reuseSession reaches the
    // runner (e.g. via the getJob-miss fallback where the in-memory job is
    // used directly). The runner emits a lifecycle notice that reuseSession was
    // ignored; that notice is a crontick-side event and must live on the
    // `crontick` stream, never on the engine (stdout/stderr) streams.
    const job = promptJob('prompt-reuse-notice', {
      sessionId: 'sess-12345678',
      reuseSession: true,
    });
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(store.getLogs(run.id, 'crontick').map((log) => log.chunk.toString('utf-8')).join('')).toContain(
      'reuseSession was ignored',
    );
    expect(store.getLogs(run.id, 'engine').map((log) => log.chunk.toString('utf-8')).join('')).not.toContain(
      'reuseSession was ignored',
    );
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
    // The captured-session-id line is a crontick-side lifecycle event: it must
    // live on the `crontick` stream, never on the engine (stdout/stderr) streams.
    expect(store.getLogs(run.id, 'crontick').map((log) => log.chunk.toString('utf-8')).join('')).toContain('captured session id');
    expect(store.getLogs(run.id, 'engine').map((log) => log.chunk.toString('utf-8')).join('')).not.toContain('captured session id');
  });

  it('prompt: captures a session id from the rolling transcript tail after long output', async () => {
    const fake = fakeSpawn([{ stdout: `${'x'.repeat(140 * 1024)}\nsession id: sess-tail1234\n` }]);
    runner = new Runner(fake.spawnFn as never);
    const job = promptJob('prompt-reuse-tail', { reuseSession: true });
    store.upsertJob(job);
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(store.getRun(run.id)?.status).toBe('success');
    expect(store.getJob(job.id)?.action).toMatchObject({
      kind: 'prompt',
      sessionId: 'sess-tail1234',
      reuseSession: false,
    });
  });

  it('prompt: skips session persistence when the job is deleted before write-back', async () => {
    const job = promptJob('prompt-reuse-deleted', { reuseSession: true });
    const fake = fakeSpawn([
      {
        stdout: 'session id: sess-delete1\n',
        beforeClose: () => {
          store.deleteJob(job.id);
        },
      },
    ]);
    runner = new Runner(fake.spawnFn as never);
    store.upsertJob(job);
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(store.getRun(run.id)?.status).toBe('success');
    expect(store.getJob(job.id)).toBeUndefined();
  });

  it('prompt: skips session persistence when the prompt action changed before write-back', async () => {
    const job = promptJob('prompt-reuse-updated', { reuseSession: true });
    const fake = fakeSpawn([
      {
        stdout: 'session id: sess-update1\n',
        beforeClose: () => {
          store.upsertJob(promptJob(job.id, { prompt: 'changed', reuseSession: true }));
        },
      },
    ]);
    runner = new Runner(fake.spawnFn as never);
    store.upsertJob(job);
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(store.getRun(run.id)?.status).toBe('success');
    expect(store.getJob(job.id)?.action).toMatchObject({
      kind: 'prompt',
      prompt: 'changed',
      reuseSession: true,
    });
  });

  it('prompt: turns session persistence failures into failed run results', async () => {
    const fake = fakeSpawn([{ stdout: 'session id: sess-failure1\n' }]);
    runner = new Runner(fake.spawnFn as never);
    const job = promptJob('prompt-reuse-persist-fail', { reuseSession: true });
    store.upsertJob(job);
    const run = store.insertRun(job.id);
    const original = store.tryCapturePromptSession.bind(store);
    store.tryCapturePromptSession = () => {
      throw new Error('disk denied');
    };

    try {
      await runner.run(job, run.id, store);
    } finally {
      store.tryCapturePromptSession = original;
    }

    expect(store.getRun(run.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('SESSION_PERSIST_FAILED'),
    });
    expect(store.getJob(job.id)?.action).toMatchObject({ kind: 'prompt', reuseSession: true });
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

    expect(fake.calls[0].args).toEqual(['--allow-all-tools', '-p', 'hello', '--session-id=sess-abcdefgh']);
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

  // ── L8: detached + windowsHide spawn options ─────────────────────────────────

  it('spawn: sets detached:true and windowsHide:true so children survive daemon exit uniformly on both platforms', async () => {
    const fake = fakeSpawn([{ code: 0 }]);
    runner = new Runner(fake.spawnFn as never);
    const job = execJob('detached-check', node, ['-e', 'process.exit(0)']);
    const run = store.insertRun(job.id);
    await runner.run(job, run.id, store);
    expect(fake.calls[0].opts?.detached).toBe(true);
    expect(fake.calls[0].opts?.windowsHide).toBe(true);
  });

  // ── L4: pid capture ───────────────────────────────────────────────────────────

  it('spawn: persists the child pid on the run row as soon as it is known', async () => {
    const job = execJob('pid-capture', node, ['-e', 'process.exit(0)']);
    const run = store.insertRun(job.id);
    await runner.run(job, run.id, store);
    const updated = store.getRun(run.id)!;
    expect(updated.pid).toBeGreaterThan(0);
  });

  // ── L5: output byte cap ───────────────────────────────────────────────────────

  describe('output byte cap (L5)', () => {
    it('stops storing further output once the cap is hit, marks outputTruncated, and appends an obvious marker', async () => {
      const cap = 32;
      runner = new Runner(undefined, undefined, cap);
      // Write far more than `cap` bytes of stdout in one go.
      const job = execJob('output-cap', node, ['-e', 'process.stdout.write("x".repeat(500))']);
      const run = store.insertRun(job.id);
      await runner.run(job, run.id, store);

      const updated = store.getRun(run.id)!;
      expect(updated.outputTruncated).toBe(true);

      const logs = store.getLogs(run.id, 'engine');
      const text = logs.map((l) => l.chunk.toString('utf-8')).join('');
      expect(text).toContain(truncationMarker(cap).trim());
      // Captured payload before the marker must not exceed the cap.
      const beforeMarker = text.split(truncationMarker(cap))[0];
      expect(Buffer.byteLength(beforeMarker, 'utf-8')).toBeLessThanOrEqual(cap);
    });

    it('does not truncate output at or under the cap', async () => {
      const cap = 1024;
      runner = new Runner(undefined, undefined, cap);
      const job = execJob('output-no-cap', node, ['-e', 'process.stdout.write("short output\\n")']);
      const run = store.insertRun(job.id);
      await runner.run(job, run.id, store);
      const updated = store.getRun(run.id)!;
      expect(updated.outputTruncated).toBe(false);
    });

    it('defaults to DEFAULT_MAX_OUTPUT_BYTES_PER_RUN (2,000,000 bytes) when no override or config value is set', async () => {
      runner = new Runner(); // no override
      const job = execJob('output-default-cap', node, ['-e', 'process.stdout.write("small\\n")']);
      const run = store.insertRun(job.id);
      await runner.run(job, run.id, store);
      expect(store.getRun(run.id)!.outputTruncated).toBe(false);
      expect(DEFAULT_MAX_OUTPUT_BYTES_PER_RUN).toBe(2_000_000);
    });

    it('truncateToUtf8Boundary: trims a trailing split multi-byte character but keeps preceding whole characters (MINOR 7 regression)', () => {
      // '€' (U+20AC) encodes as 3 UTF-8 bytes (0xE2 0x82 0xAC). Keeping only
      // the first 2 of those 3 bytes reproduces exactly what an arbitrary
      // byte-offset truncation cap does when it cuts mid-character.
      const euro = Buffer.from('€', 'utf-8');
      expect(euro.length).toBe(3);
      const splitOnly = euro.subarray(0, 2);
      expect(truncateToUtf8Boundary(splitOnly).length).toBe(0); // dangling partial char dropped entirely
      const wholeThenSplit = Buffer.concat([Buffer.from('ab', 'utf-8'), splitOnly]);
      expect(truncateToUtf8Boundary(wholeThenSplit).toString('utf-8')).toBe('ab');
      // A buffer that already ends on a full character must be left untouched.
      const wholeOnly = Buffer.from('ab€', 'utf-8');
      expect(truncateToUtf8Boundary(wholeOnly)).toEqual(wholeOnly);
    });

    it('captureChunk: truncation at the byte cap does not split a multi-byte character (MINOR 7 regression)', async () => {
      // Cap lands 2 bytes into the 3-byte '€' that follows "ab": before the
      // fix, the raw byte slice kept that dangling partial character, which
      // decodes as U+FFFD (the UTF-8 replacement character) — corrupting the
      // stored log text right before the truncation marker.
      const cap = 4;
      runner = new Runner(undefined, undefined, cap);
      const job = execJob('output-cap-utf8', node, ['-e', 'process.stdout.write("ab€cd")']);
      const run = store.insertRun(job.id);
      await runner.run(job, run.id, store);
      expect(store.getRun(run.id)!.outputTruncated).toBe(true);

      const text = store.getLogs(run.id, 'engine').map((l) => l.chunk.toString('utf-8')).join('');
      const beforeMarker = text.split(truncationMarker(cap))[0];
      expect(beforeMarker).not.toContain('\uFFFD');
      expect(beforeMarker).toBe('ab');
    });
  });

  // ── Session-id capture on the run row + crontick log stream + per-job file ──

  describe('run session id + crontick log stream + per-job file logging', () => {
    it('persists an extracted session id (generic session-id footer) onto the run row', async () => {
      const uuid = 'b4823c07-1617-489e-9fe4-820a42ba8677';
      const fake = fakeSpawn([{ stderr: `session id: ${uuid}\n` }]);
      runner = new Runner(fake.spawnFn as never);
      const job = promptJob('run-sessionid-extracted', { reuseSession: true });
      store.upsertJob(job);
      const run = store.insertRun(job.id);

      await runner.run(job, run.id, store);

      expect(store.getRun(run.id)?.status).toBe('success');
      expect(store.getRun(run.id)?.sessionId).toBe(uuid);
    });

    it('persists an explicitly provided session id onto the run row', async () => {
      const fake = fakeSpawn([{ stdout: 'ok\n' }]);
      runner = new Runner(fake.spawnFn as never);
      const job = promptJob('run-sessionid-explicit', { sessionId: 'sess-explicit1', reuseSession: false });
      store.upsertJob(job);
      const run = store.insertRun(job.id);

      await runner.run(job, run.id, store);

      expect(store.getRun(run.id)?.sessionId).toBe('sess-explicit1');
    });

    it('records crontick lifecycle events on the `crontick` stream, absent from the engine streams', async () => {
      const job = execJob('crontick-stream', node, ['-e', 'process.stdout.write("engine-output")']);
      const run = store.insertRun(job.id);
      await runner.run(job, run.id, store);

      const crontickText = store.getLogs(run.id, 'crontick').map((l) => l.chunk.toString('utf-8')).join('');
      expect(crontickText).toContain('[crontick] run started');
      expect(crontickText).toContain('[crontick] executing');
      expect(crontickText).toContain('[crontick] run finished');

      const engineText = store.getLogs(run.id, 'engine').map((l) => l.chunk.toString('utf-8')).join('');
      expect(engineText).toBe('engine-output');
      expect(engineText).not.toContain('[crontick]');

      // 'all' returns both streams.
      const allStreams = new Set(store.getLogs(run.id, 'all').map((l) => l.stream));
      expect(allStreams.has('crontick')).toBe(true);
      expect(allStreams.has('stdout')).toBe(true);
    });

    it('mirrors run output to the injectable per-job log-file sink (best-effort seam)', async () => {
      const writes: Array<{ jobId: string; text: string }> = [];
      const fakeFactory = {
        open(jobId: string) {
          return { write: (text: string) => { writes.push({ jobId, text }); } };
        },
      };
      const job = execJob('file-sink', node, ['-e', 'process.stdout.write("hello-file")']);
      runner = new Runner(undefined, undefined, undefined, undefined, fakeFactory);
      const run = store.insertRun(job.id);
      await runner.run(job, run.id, store);

      const joined = writes.map((w) => w.text).join('');
      expect(writes.every((w) => w.jobId === job.id)).toBe(true);
      expect(joined).toContain('hello-file');
      expect(joined).toContain('[crontick] run started');
      expect(joined).toContain('[crontick] run finished');
    });

    it('never fails a run when the per-job file sink throws (non-blocking)', async () => {
      const throwingFactory = {
        open() {
          return { write: () => { throw new Error('disk full'); } };
        },
      };
      const job = execJob('file-sink-throws', node, ['-e', 'process.stdout.write("still-ok")']);
      runner = new Runner(undefined, undefined, undefined, undefined, throwingFactory);
      const run = store.insertRun(job.id);
      await runner.run(job, run.id, store);

      expect(store.getRun(run.id)?.status).toBe('success');
      expect(store.getLogs(run.id, 'engine').map((l) => l.chunk.toString('utf-8')).join('')).toBe('still-ok');
    });
  });

  // ── L3/L4: adoptRun restores overlap invariants across a restart ─────────────

  describe('adoptRun', () => {
    it('uses a Claude marker after an adopted process exits instead of the unknown-exit fallback', async () => {
      const jobId = 'adopt-hook';
      const child = nodeSpawn(node, ['-e', 'setTimeout(() => process.exit(0), 10000)']);
      const adoptedRun = store.insertRun(jobId);
      store.updateRun(adoptedRun.id, { status: 'running', pid: child.pid!, sessionId: 'claude-session' });
      const markerDir = join(dir, 'runs');
      mkdirSync(markerDir);
      const priorHome = process.env['CRONTICK_HOME'];
      process.env['CRONTICK_HOME'] = dir;
      try {
        writeFileSync(join(markerDir, `${adoptedRun.id}.claude-hook.json`),
          JSON.stringify({ exitStatus: 7, sessionId: 'claude-session' }));
        runner = new Runner(undefined, undefined, undefined, 50);
        runner.adoptRun(jobId, adoptedRun.id, child.pid!, store);
        child.kill();
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && store.getRun(adoptedRun.id)!.status === 'running') {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(store.getRun(adoptedRun.id)).toMatchObject({ status: 'failed', exitCode: 7 });
        expect(store.getRun(adoptedRun.id)?.error).not.toBe(ADOPTED_RUN_EXITED_MESSAGE);
      } finally {
        child.kill();
        if (priorHome === undefined) delete process.env['CRONTICK_HOME'];
        else process.env['CRONTICK_HOME'] = priorHome;
      }
    }, 15_000);

    it('overlap=skip: a job with an adopted, still-alive run skips new ticks until the adopted process exits', async () => {
      const jobId = 'adopt-skip';
      const child = nodeSpawn(node, ['-e', 'setTimeout(() => process.exit(0), 10000)']);
      const adoptedRun = store.insertRun(jobId);
      store.updateRun(adoptedRun.id, { status: 'running', pid: child.pid! });

      runner = new Runner(undefined, undefined, undefined, 50); // fast adopted-poll for the test
      runner.adoptRun(jobId, adoptedRun.id, child.pid!, store);

      const job = execJob(jobId, node, ['-e', 'process.exit(0)'], { overlap: 'skip' });
      const skippedRun = store.insertRun(jobId);
      await runner.run(job, skippedRun.id, store);
      expect(store.getRun(skippedRun.id)).toMatchObject({
        status: 'skipped',
        error: expect.stringContaining('overlap=skip'),
      });

      // Let the adopted process die (simulating it exiting on its own) and
      // poll for adoptRun's own liveness poll to notice and clear the slot.
      child.kill();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && store.getRun(adoptedRun.id)!.status === 'running') {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(store.getRun(adoptedRun.id)).toMatchObject({
        status: 'canceled',
        error: ADOPTED_RUN_EXITED_MESSAGE,
      });
      expect(isProcessAlive(child.pid!)).toBe(false);

      // The job slot is now free — a subsequent overlap=skip run must proceed normally.
      const nextRun = store.insertRun(jobId);
      await runner.run(job, nextRun.id, store);
      expect(store.getRun(nextRun.id)?.status).toBe('success');
    }, 15_000);

    it('overlap=cancel-previous: canceling a new tick against an adopted run sends SIGTERM to the real pid', async () => {
      const jobId = 'adopt-cancel-previous';
      const child = nodeSpawn(node, ['-e', 'setTimeout(() => process.exit(0), 10000)']);
      const adoptedRun = store.insertRun(jobId);
      store.updateRun(adoptedRun.id, { status: 'running', pid: child.pid! });

      runner = new Runner(undefined, undefined, undefined, 50);
      runner.adoptRun(jobId, adoptedRun.id, child.pid!, store);
      expect(isProcessAlive(child.pid!)).toBe(true);

      const job = execJob(jobId, node, ['-e', 'process.exit(0)'], { overlap: 'cancel-previous' });
      const newRun = store.insertRun(jobId);
      await runner.run(job, newRun.id, store);

      // The abort listener registered by adoptRun() SIGTERMs the real pid —
      // poll for it to actually die rather than asserting on a fixed sleep.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && isProcessAlive(child.pid!)) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(isProcessAlive(child.pid!)).toBe(false);
      expect(store.getRun(newRun.id)?.status).toBe('success');

      // Give adoptRun's own poll a chance to observe the death and finalize
      // the adopted run row as "terminated" (canceledByAbort branch).
      const finalizeDeadline = Date.now() + 5000;
      while (Date.now() < finalizeDeadline && store.getRun(adoptedRun.id)!.status === 'running') {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(store.getRun(adoptedRun.id)).toMatchObject({
        status: 'canceled',
        error: expect.stringContaining('terminated'),
      });
    }, 15_000);

    it('cancelRun called directly on an adopted run attributes deliberate termination, not ADOPTED_RUN_EXITED_MESSAGE', async () => {
      // Distinct from the overlap=cancel-previous scenario above: this exercises
      // the explicit `crontick jobs cancel`/API path (Runner.cancelRun) against an
      // adopted run directly, with no competing new run involved at all.
      const jobId = 'adopt-direct-cancel';
      const child = nodeSpawn(node, ['-e', 'setTimeout(() => process.exit(0), 10000)']);
      const adoptedRun = store.insertRun(jobId);
      store.updateRun(adoptedRun.id, { status: 'running', pid: child.pid! });

      runner = new Runner(undefined, undefined, undefined, 50);
      runner.adoptRun(jobId, adoptedRun.id, child.pid!, store);

      expect(runner.cancelRun(adoptedRun.id)).toBe(true);

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && store.getRun(adoptedRun.id)!.status === 'running') {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(store.getRun(adoptedRun.id)).toMatchObject({
        status: 'canceled',
        error: expect.stringContaining('terminated'),
      });
    }, 15_000);

    it('adoption poll re-verifies pid identity every tick, not just isProcessAlive (pid-reuse-during-poll regression, L3)', async () => {
      // Simulates a pid reused mid-poll: the child spawned below is genuinely
      // alive for the whole test (so isProcessAlive(pid) alone would say
      // "still running" forever), but the adopted run's recorded startedAt is
      // deliberately set 24h in the past — a real OS start time that recent
      // can never match it, exactly the "different process now owns this pid"
      // shape. Before the fix, adoptRun()'s poll only called
      // isProcessAlive(pid) and would never notice; the job would stay marked
      // active in this daemon's memory forever, and a later cancel-previous
      // decision could eventually SIGTERM this now-unrelated process.
      const jobId = 'adopt-poll-pid-reuse';
      const child = nodeSpawn(node, ['-e', 'setTimeout(() => process.exit(0), 10000)']);
      const bogusStartedAt = Date.now() - 24 * 60 * 60 * 1000;
      const adoptedRun = store.insertRun(jobId, bogusStartedAt);
      store.updateRun(adoptedRun.id, { status: 'running', pid: child.pid! });

      runner = new Runner(undefined, undefined, undefined, 50);
      runner.adoptRun(jobId, adoptedRun.id, child.pid!, store);

      try {
        // Generous deadline: the poll re-verifies identity by shelling out to
        // the OS for the pid's real start time, which can be slow on a loaded
        // Windows runner (powershell.exe cold start).
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline && store.getRun(adoptedRun.id)!.status === 'running') {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(store.getRun(adoptedRun.id)).toMatchObject({
          status: 'canceled',
          error: ADOPTED_RUN_EXITED_MESSAGE,
        });
        // This mismatch-detection path only clears bookkeeping — it must never
        // itself signal the pid, since (from crontick's point of view, given
        // the mismatched startedAt) this might not even be the process it
        // thinks it is.
        expect(isProcessAlive(child.pid!)).toBe(true);
      } finally {
        child.kill();
      }
    }, 40_000);
  });
});
