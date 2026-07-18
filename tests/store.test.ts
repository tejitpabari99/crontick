import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
    catchup: 'skip',
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
    budgets: { maxRunsPerDay: null, maxTokensPerRun: null },
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

  it('getLastRun returns most recent terminal run', () => {
    const r1 = store.insertRun('job-z');
    store.updateRun(r1.id, { status: 'success' });
    expect(store.getLastRun('job-z')?.id).toBe(r1.id);
  });

  it('countRunsSince counts correctly', () => {
    const past = Date.now() - 10000;
    store.insertRun('job-c');
    store.insertRun('job-c');
    expect(store.countRunsSince('job-c', past)).toBe(2);
    expect(store.countRunsSince('job-c', Date.now() + 10000)).toBe(0);
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
});
