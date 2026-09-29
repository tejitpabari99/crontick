/**
 * Regression: an engine that reports a terminal error (e.g. Claude 401
 * "OAuth access token is invalid") but does not exit used to leave the run
 * "running" for minutes, so every later tick was recorded as
 * `skipped` (overlap=skip: another run is already active).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { Runner } from '../../src/daemon/runner.js';
import { ClaudeAdapter } from '../../src/engines/claude-adapter.js';
import { Store } from '../../src/daemon/store.js';
import type { Job } from '../../src/schemas/job.js';
import { EXIT_CLOSE_GRACE_MS, KILL_GRACE_MS, TERMINAL_ERROR_SETTLE_MS } from '../../src/constants/daemon.js';

const AUTH_MESSAGE = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token is invalid"}}';

const assistantAuthError = JSON.stringify({
  type: 'assistant',
  error: 'authentication_failed',
  message: { role: 'assistant', content: [{ type: 'text', text: AUTH_MESSAGE }] },
});
const resultAuthError = JSON.stringify({
  type: 'result', subtype: 'success', is_error: true, result: AUTH_MESSAGE, session_id: 'sess-1', num_turns: 1, total_cost_usd: 0,
});
const resultOk = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sess-2', num_turns: 1, total_cost_usd: 0,
});

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'auth-job',
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: { kind: 'prompt', prompt: 'hello', engine: 'claude', args: [], reuseSession: false },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
    ...overrides,
  };
}

/** Each spawn returns a child that writes `lines` and then hangs (never exits) unless `exitAfter` is set. */
function makeSpawn(script: Array<{ lines: string[]; exit?: 'close' | 'exit-only' | 'never' }>) {
  const children: FakeChild[] = [];
  const spawnFn = ((_cmd: string, _args?: readonly string[], _opts?: SpawnOptions): ChildProcess => {
    const step = script[Math.min(children.length, script.length - 1)]!;
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 40000 + children.length;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);
    children.push(child);
    queueMicrotask(() => {
      for (const line of step.lines) child.stdout.write(`${line}\n`);
      if (step.exit === 'close') child.emit('close', 0, null);
      if (step.exit === 'exit-only') child.emit('exit', 0, null);
    });
    return child as unknown as ChildProcess;
  }) as unknown as typeof import('node:child_process').spawn;
  return { children, spawnFn };
}

describe('Runner: terminal engine errors', () => {
  let dir: string;
  let store: Store;
  let previousHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crontick-terminal-'));
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    previousHome = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
    store.open();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
    if (previousHome === undefined) delete process.env['CRONTICK_HOME'];
    else process.env['CRONTICK_HOME'] = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails the run with the parsed error, kills the process tree, releases the lock, and the next tick runs', async () => {
    const { children, spawnFn } = makeSpawn([
      { lines: [assistantAuthError, resultAuthError], exit: 'never' },
      { lines: [resultOk], exit: 'close' },
    ]);
    const killTree = vi.fn();
    const runner = new Runner(spawnFn, undefined, undefined, undefined, undefined, undefined, killTree);
    const job = makeJob();

    const first = store.insertRun(job.id);
    const firstDone = runner.run(job, first.id, store);
    await vi.advanceTimersByTimeAsync(0);
    // Not finalized yet: the engine gets a short grace period to exit by itself.
    expect(store.getRun(first.id)!.status).toBe('running');
    await vi.advanceTimersByTimeAsync(TERMINAL_ERROR_SETTLE_MS);
    await firstDone;

    const failed = store.getRun(first.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('Failed to authenticate');
    expect(failed.error).toContain('401');
    expect(failed.endedAt).toBeDefined();
    expect(killTree).toHaveBeenCalledWith(children[0], false);

    // A still-hung process is force-killed after the grace period.
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(killTree).toHaveBeenCalledWith(children[0], true);

    // Lock released: the next scheduled tick runs instead of being `skipped`.
    const second = store.insertRun(job.id);
    const secondDone = runner.run(job, second.id, store);
    await vi.advanceTimersByTimeAsync(0);
    await secondDone;
    expect(store.getRun(second.id)!.status).toBe('success');
    expect(children).toHaveLength(2);
  });

  it('does not retry an authentication failure', async () => {
    const { children, spawnFn } = makeSpawn([{ lines: [resultAuthError], exit: 'never' }]);
    const runner = new Runner(spawnFn, undefined, undefined, undefined, undefined, undefined, vi.fn());
    const job = makeJob({ retry: { max: 3, backoffSec: 1 } });
    const run = store.insertRun(job.id);
    const done = runner.run(job, run.id, store);
    await vi.advanceTimersByTimeAsync(TERMINAL_ERROR_SETTLE_MS);
    await done;
    expect(children).toHaveLength(1);
    expect(store.getRun(run.id)!.status).toBe('failed');
  });

  it('keeps the real exit code when the engine exits by itself within the grace period', async () => {
    const { spawnFn } = makeSpawn([{ lines: [resultAuthError], exit: 'close' }]);
    const killTree = vi.fn();
    const runner = new Runner(spawnFn, undefined, undefined, undefined, undefined, undefined, killTree);
    const job = makeJob();
    const run = store.insertRun(job.id);
    const done = runner.run(job, run.id, store);
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', exitCode: 0 });
    expect(store.getRun(run.id)!.error).toContain('Failed to authenticate');
    expect(killTree).not.toHaveBeenCalled();
  });

  it('finalizes a run whose process exited but whose stdio never closed', async () => {
    const { spawnFn } = makeSpawn([{ lines: [resultOk], exit: 'exit-only' }]);
    const runner = new Runner(spawnFn, undefined, undefined, undefined, undefined, undefined, vi.fn());
    const job = makeJob();
    const run = store.insertRun(job.id);
    const done = runner.run(job, run.id, store);
    await vi.advanceTimersByTimeAsync(EXIT_CLOSE_GRACE_MS);
    await done;
    expect(store.getRun(run.id)!.status).toBe('success');
  });

  it('force-kills and finalizes a timed-out run that ignores SIGTERM', async () => {
    const { children, spawnFn } = makeSpawn([{ lines: [], exit: 'never' }]);
    const killTree = vi.fn();
    const runner = new Runner(spawnFn, undefined, undefined, undefined, undefined, undefined, killTree);
    const job = makeJob({ action: { kind: 'prompt', prompt: 'hello', engine: 'claude', args: [], reuseSession: false, timeoutSec: 1 } });
    const run = store.insertRun(job.id);
    const done = runner.run(job, run.id, store);
    await vi.advanceTimersByTimeAsync(1000 + KILL_GRACE_MS + EXIT_CLOSE_GRACE_MS);
    await done;
    expect(children[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    expect(killTree).toHaveBeenCalledWith(children[0], true);
    expect(store.getRun(run.id)!.status).toBe('timeout');
  });
});

describe('ClaudeAdapter.detectTerminalError', () => {
  const adapter = new ClaudeAdapter();

  it('detects a result event with is_error and marks authentication failures non-retryable', () => {
    expect(adapter.detectTerminalError(resultAuthError)).toEqual({ message: AUTH_MESSAGE, retryable: false });
    const other = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Reached max turns' });
    expect(adapter.detectTerminalError(other)).toEqual({ message: 'Reached max turns', retryable: true });
  });

  it('detects an authentication api-error assistant message', () => {
    expect(adapter.detectTerminalError(assistantAuthError)).toEqual({ message: AUTH_MESSAGE, retryable: false });
  });

  it('ignores healthy events, non-JSON lines, and non-auth assistant errors', () => {
    expect(adapter.detectTerminalError(resultOk)).toBeUndefined();
    expect(adapter.detectTerminalError('not json')).toBeUndefined();
    expect(adapter.detectTerminalError(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }))).toBeUndefined();
    expect(adapter.detectTerminalError(JSON.stringify({ type: 'assistant', error: 'rate_limit', message: { content: [] } }))).toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('killProcessTree (POSIX)', () => {
  it('terminates a detached child together with its own child processes', async () => {
    const { spawn } = await import('node:child_process');
    const { killProcessTree } = await import('../../src/daemon/process-tree.js');
    const { isProcessAlive } = await import('../../src/process-liveness.js');
    vi.useRealTimers();
    const child = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      console.log(grandchild.pid);
      setTimeout(() => {}, 60000);
    `], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchildPid = await new Promise<number>((resolve) => {
      child.stdout!.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    });
    expect(isProcessAlive(grandchildPid)).toBe(true);
    killProcessTree(child, false);
    await new Promise((resolve) => child.once('exit', resolve));
    for (let i = 0; i < 50 && isProcessAlive(grandchildPid); i++) await new Promise((r) => setTimeout(r, 50));
    expect(isProcessAlive(grandchildPid)).toBe(false);
  });
});
