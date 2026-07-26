import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/daemon/store.js';
import type { Job } from '../src/schemas/job.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'crontick-test-'));
}

function makeStore(dir: string): Store {
  const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
  return store;
}

function execJob(id: string): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: { kind: 'exec', command: 'echo', args: ['hello'] },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
  };
}

function promptJob(id: string): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: {
      kind: 'prompt',
      prompt: 'Summarize status',
      engine: 'copilot',
      args: [],
      reuseSession: false,
    },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
  };
}

describe('Store', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = makeTmpDir();
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    store = makeStore(dir);
    store.open();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── Job CRUD ────────────────────────────────────────────────────────────────

  it('upsertJob and getJob round-trips a job', () => {
    store.upsertJob(execJob('test-job'));
    const retrieved = store.getJob('test-job');
    expect(retrieved).toBeTruthy();
    expect(retrieved?.id).toBe('test-job');
  });

  it('upsertJob and getJob round-trips a prompt job', () => {
    store.upsertJob(promptJob('prompt-job'));
    const retrieved = store.getJob('prompt-job');
    expect(retrieved?.action).toMatchObject({
      kind: 'prompt',
      prompt: 'Summarize status',
      engine: 'copilot',
    });
  });

  it('tryCapturePromptSession only updates an unchanged reusable prompt job', () => {
    const base = promptJob('prompt-capture');
    const job = { ...base, action: { ...base.action, reuseSession: true } } as Job;
    store.upsertJob(job);

    expect(
      store.tryCapturePromptSession(
        job.id,
        job.action as Extract<Job['action'], { kind: 'prompt' }>,
        'sess-12345678',
      ),
    ).toBe(true);
    expect(store.getJob(job.id)?.action).toMatchObject({
      kind: 'prompt',
      sessionId: 'sess-12345678',
      reuseSession: false,
    });
    expect(JSON.parse(readFileSync(join(dir, 'jobs', `${job.id}.json`), 'utf-8')).action).toMatchObject({
      sessionId: 'sess-12345678',
      reuseSession: false,
    });

    const original = promptJob('prompt-capture-updated');
    const originalAction = original.action as Extract<Job['action'], { kind: 'prompt' }>;
    store.upsertJob({
      ...original,
      action: { ...originalAction, prompt: 'Changed', reuseSession: true },
    });
    expect(
      store.tryCapturePromptSession(
        original.id,
        originalAction,
        'sess-abcdefgh',
      ),
    ).toBe(false);
    expect(store.getJob(original.id)?.action).toMatchObject({
      kind: 'prompt',
      prompt: 'Changed',
      reuseSession: true,
    });
  });

  it('listJobs returns all jobs', () => {
    for (let i = 0; i < 3; i++) store.upsertJob(execJob(`job-${i}`));
    expect(store.listJobs()).toHaveLength(3);
  });

  it('deleteJob removes job and returns true', () => {
    store.upsertJob(execJob('del-me'));
    expect(store.deleteJob('del-me')).toBe(true);
    expect(store.getJob('del-me')).toBeUndefined();
  });

  it('deleteJob returns false for missing job', () => {
    expect(store.deleteJob('ghost')).toBe(false);
  });

  it('upsertJob is idempotent — updates in place', () => {
    store.upsertJob(execJob('idem-job'));
    store.upsertJob({ ...execJob('idem-job'), enabled: false });
    expect(store.getJob('idem-job')?.enabled).toBe(false);
    expect(store.listJobs()).toHaveLength(1);
  });

  // ── Run CRUD ────────────────────────────────────────────────────────────────

  it('insertRun creates a run with queued status', () => {
    const run = store.insertRun('test-job');
    expect(run.id).toBeTruthy();
    expect(run.status).toBe('queued');
    expect(run.jobId).toBe('test-job');
  });

  it('updateRun changes status', () => {
    const run = store.insertRun('test-job');
    store.updateRun(run.id, { status: 'running' });
    expect(store.getRun(run.id)?.status).toBe('running');
  });

  it('updateRun sets exit fields', () => {
    const run = store.insertRun('test-job');
    const now = Date.now();
    store.updateRun(run.id, { status: 'success', exitCode: 0, endedAt: now, durationMs: 123 });
    const retrieved = store.getRun(run.id);
    expect(retrieved?.status).toBe('success');
    expect(retrieved?.exitCode).toBe(0);
    expect(retrieved?.durationMs).toBe(123);
  });

  it('listRuns filters by jobId', () => {
    store.insertRun('job-a');
    store.insertRun('job-a');
    store.insertRun('job-b');
    expect(store.listRuns({ jobId: 'job-a' })).toHaveLength(2);
    expect(store.listRuns({ jobId: 'job-b' })).toHaveLength(1);
  });

  it('listRuns respects limit', () => {
    for (let i = 0; i < 5; i++) store.insertRun('job-x');
    expect(store.listRuns({ limit: 3 })).toHaveLength(3);
  });

  it('listRuns filters by since', async () => {
    store.insertRun('job-s');
    await new Promise((r) => setTimeout(r, 5));
    const since = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    store.insertRun('job-s');
    expect(store.listRuns({ jobId: 'job-s', since })).toHaveLength(1);
  });

  // ── Logs ────────────────────────────────────────────────────────────────────

  it('appendLog and getLogs round-trips', () => {
    const run = store.insertRun('log-job');
    store.appendLog(run.id, 'stdout', Buffer.from('hello\n'));
    store.appendLog(run.id, 'stderr', Buffer.from('err\n'));
    const logs = store.getLogs(run.id);
    expect(logs).toHaveLength(2);
    expect(logs[0].chunk.toString('utf-8')).toBe('hello\n');
    expect(logs[0].stream).toBe('stdout');
    expect(logs[1].stream).toBe('stderr');
  });

  it('tailLogs returns only logs after sinceTs', async () => {
    const run = store.insertRun('tail-job');
    store.appendLog(run.id, 'stdout', Buffer.from('before\n'));
    await new Promise((r) => setTimeout(r, 15));
    const sinceTs = Date.now();
    await new Promise((r) => setTimeout(r, 15));
    store.appendLog(run.id, 'stdout', Buffer.from('after\n'));
    const tailed = store.tailLogs(run.id, sinceTs);
    expect(tailed).toHaveLength(1);
    expect(tailed[0].chunk.toString('utf-8')).toBe('after\n');
  });

  // ── Migrations idempotency ──────────────────────────────────────────────────

  it('open() is idempotent — re-open applies no extra migrations', () => {
    store.close();
    store.open();
    expect(store.listJobs()).toHaveLength(0);
  });

  // ── File persistence ────────────────────────────────────────────────────────

  it('loadJobsFromDisk picks up JSON files', () => {
    const jobsPath = join(dir, 'jobs');
    const jobJson = JSON.stringify(execJob('disk-job'));
    writeFileSync(join(jobsPath, 'disk-job.json'), jobJson);

    const store2 = makeStore(dir);
    store2.open();
    store2.loadJobsFromDisk();
    expect(store2.getJob('disk-job')).toBeTruthy();
    store2.close();
  });

  it('loadJobsFromDisk ignores malformed files', () => {
    const jobsPath = join(dir, 'jobs');
    writeFileSync(join(jobsPath, 'bad.json'), 'not valid json{{{');
    store.loadJobsFromDisk(); // should not throw
    expect(store.listJobs()).toHaveLength(0);
  });

  // ── Run retention ─────────────────────────────────────────────────────────────

  it('evicts the oldest run at exactly the 101st run for a job', () => {
    for (let i = 0; i < 100; i++) {
      const run = store.insertRun('job-a', 1000 + i);
      store.updateRun(run.id, { status: 'success' });
    }
    expect(store.listRuns({ jobId: 'job-a' })).toHaveLength(100);

    const oldest = store.listRuns({ jobId: 'job-a' }).sort((a, b) => a.startedAt - b.startedAt)[0];
    const run101 = store.insertRun('job-a', 1000 + 100);
    store.updateRun(run101.id, { status: 'success' });

    expect(store.listRuns({ jobId: 'job-a' })).toHaveLength(100);
    expect(store.getRun(oldest.id)).toBeUndefined();
    expect(store.getRun(run101.id)).toBeTruthy();
  });

  it('never evicts in-flight (running/queued) runs even when they are the oldest', () => {
    for (let i = 0; i < 100; i++) {
      const run = store.insertRun('job-b', 2000 + i);
      store.updateRun(run.id, { status: 'success' });
    }
    // Leave this one queued (do not mark terminal) — it must survive.
    const queuedRun = store.insertRun('job-b', 1); // oldest startedAt of all, but non-terminal
    expect(store.getRun(queuedRun.id)?.status).toBe('queued');
    expect(store.listRuns({ jobId: 'job-b' })).toHaveLength(100); // 99 terminal survivors + queued

    // Repeat with 'running' status.
    for (let i = 0; i < 100; i++) {
      const run = store.insertRun('job-b2', 3000 + i);
      store.updateRun(run.id, { status: 'success' });
    }
    const runningRun = store.insertRun('job-b2', 2);
    store.updateRun(runningRun.id, { status: 'running' });
    expect(store.getRun(runningRun.id)?.status).toBe('running');
    expect(store.listRuns({ jobId: 'job-b2' })).toHaveLength(100);
  });

  it('removes run_logs for evicted runs (no orphaned log rows)', () => {
    const run = store.insertRun('job-c', 0);
    store.appendLog(run.id, 'stdout', Buffer.from('hi\n'));
    store.appendLog(run.id, 'stderr', Buffer.from('err\n'));
    store.updateRun(run.id, { status: 'success' });

    for (let i = 0; i < 100; i++) {
      const r = store.insertRun('job-c', 100 + i);
      store.updateRun(r.id, { status: 'success' });
    }

    expect(store.getRun(run.id)).toBeUndefined();
    expect(store.getLogs(run.id)).toEqual([]);
  });

  it('respects a custom retention cap passed to the constructor', () => {
    const smallCapStore = new Store(join(dir, 'runs.db'), join(dir, 'jobs'), undefined, 3);
    smallCapStore.open();
    try {
      for (let i = 0; i < 5; i++) {
        const run = smallCapStore.insertRun('job-d', i);
        smallCapStore.updateRun(run.id, { status: 'success' });
      }
      expect(smallCapStore.listRuns({ jobId: 'job-d' })).toHaveLength(3);
    } finally {
      smallCapStore.close();
    }
  });

  it('breaks started_at ties by insertion order (rowid), evicting the earlier-inserted run first', () => {
    const smallCapStore = new Store(join(dir, 'runs.db'), join(dir, 'jobs'), undefined, 2);
    smallCapStore.open();
    try {
      const same = 5000;
      const first = smallCapStore.insertRun('job-e', same);
      smallCapStore.updateRun(first.id, { status: 'success' });
      const second = smallCapStore.insertRun('job-e', same); // identical startedAt, inserted later
      smallCapStore.updateRun(second.id, { status: 'success' });
      const third = smallCapStore.insertRun('job-e', same + 1);
      smallCapStore.updateRun(third.id, { status: 'success' });

      // Cap is 2: the earlier-inserted of the two same-timestamp runs is evicted first.
      expect(smallCapStore.getRun(first.id)).toBeUndefined();
      expect(smallCapStore.getRun(second.id)).toBeTruthy();
      expect(smallCapStore.getRun(third.id)).toBeTruthy();
    } finally {
      smallCapStore.close();
    }
  });
});
