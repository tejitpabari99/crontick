import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Runner } from '../../src/daemon/runner.js';
import { Store } from '../../src/daemon/store.js';
import type { Job } from '../../src/schemas/job.js';

const pwshProbe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore' });
const hasPwsh = !pwshProbe.error && pwshProbe.status === 0;

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crontick-pwsh-utf8-'));
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

function streamBytes(store: Store, runId: string, stream: 'stdout' | 'stderr'): Buffer {
  return Buffer.concat(
    store.getLogs(runId)
      .filter((entry) => entry.stream === stream)
      .map((entry) => entry.chunk),
  );
}

function persistedStreamBytes(dir: string, runId: string, stream: 'stdout' | 'stderr'): Buffer {
  const db = new DatabaseSync(join(dir, 'runs.db'));
  try {
    const rows = db.prepare('SELECT chunk FROM run_logs WHERE run_id = ? AND stream = ? ORDER BY id')
      .all(runId, stream) as Array<{ chunk: Uint8Array }>;
    return Buffer.concat(rows.map((row) => Buffer.from(row.chunk)));
  } finally {
    db.close();
  }
}

interface SpawnCall {
  cmd: string;
  args: string[];
  opts?: SpawnOptions;
}

function fakeSpawn(outputs: Array<{ stdoutChunks?: Buffer[]; stderrChunks?: Buffer[]; code?: number }>) {
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
      unref: () => child,
    });
    const output = outputs[Math.min(calls.length - 1, outputs.length - 1)] ?? {};
    queueMicrotask(() => {
      for (const chunk of output.stdoutChunks ?? []) stdout.write(chunk);
      for (const chunk of output.stderrChunks ?? []) stderr.write(chunk);
      stdout.end();
      stderr.end();
      child.emit('close', output.code ?? 0, null);
    });
    return child;
  };
  return { calls, spawnFn };
}

describe('CTD-008 PowerShell UTF-8 fidelity', () => {
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

  it('reassembles a stdout UTF-8 character that is split across chunk boundaries', async () => {
    const euro = Buffer.from('€', 'utf-8');
    const fake = fakeSpawn([{ stdoutChunks: [euro.subarray(0, 2), euro.subarray(2)], code: 0 }]);
    runner = new Runner(fake.spawnFn as never);
    const job = scriptJob(`pwsh-utf8-stdout-${++sequence}`, "Write-Output 'unused'");
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(store.getRun(run.id)).toMatchObject({ status: 'success', exitCode: 0 });
    const stdoutBytes = streamBytes(store, run.id, 'stdout');
    expect(stdoutBytes).toEqual(euro);
    expect(stdoutBytes.toString('utf-8')).toBe('€');
    expect(stdoutBytes.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
  });

  it('buffers stdout and stderr tails independently when each stream splits a multibyte character', async () => {
    const stdoutTarget = Buffer.from('中', 'utf-8');
    const stderrTarget = Buffer.from('😀', 'utf-8');
    const fake = fakeSpawn([{
      stdoutChunks: [stdoutTarget.subarray(0, 2), stdoutTarget.subarray(2)],
      stderrChunks: [stderrTarget.subarray(0, 3), stderrTarget.subarray(3)],
      code: 0,
    }]);
    runner = new Runner(fake.spawnFn as never);
    const job = scriptJob(`pwsh-utf8-stderr-${++sequence}`, "Write-Output 'unused'");
    const run = store.insertRun(job.id);

    await runner.run(job, run.id, store);

    expect(streamBytes(store, run.id, 'stdout')).toEqual(stdoutTarget);
    expect(streamBytes(store, run.id, 'stderr')).toEqual(stderrTarget);
  });

  describe.runIf(hasPwsh)('real pwsh capture', () => {
    it('persists raw UTF-8 bytes for café 你好 😀 without replacement characters', async () => {
      const job = scriptJob(`pwsh-utf8-real-${++sequence}`, 'Write-Output "café 你好 😀"');
      const run = store.insertRun(job.id);

      await runner.run(job, run.id, store);

      expect(store.getRun(run.id)).toMatchObject({ status: 'success', exitCode: 0 });
      const persistedBytes = persistedStreamBytes(dir, run.id, 'stdout');
      // PowerShell appends the platform line ending (CRLF on Windows, LF on Linux/macOS),
      // so normalize the trailing newline before asserting. The point of this test is UTF-8
      // fidelity: exact multibyte content preserved with no replacement characters.
      expect(persistedBytes.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
      expect(persistedBytes.toString('utf-8').replace(/\r?\n$/, '')).toBe('café 你好 😀');
    }, 15_000);
  });
});
