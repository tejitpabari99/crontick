import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/daemon/store.js';
import { createLogger, type LogEvent } from '../src/logger.js';
import type { Job } from '../src/schemas/job.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'crontick-test-'));
}

function makeStore(dir: string): Store {
  const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
  return store;
}

/** Store wired to a capturing logger so log level/content can be asserted directly. */
function makeStoreWithEvents(dir: string): { store: Store; events: LogEvent[] } {
  const events: LogEvent[] = [];
  const logger = createLogger({ level: 'debug', sink: (event) => events.push(event) });
  const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'), logger);
  return { store, events };
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

  it('upsertJob writes job JSON files with owner-only permissions on POSIX', () => {
    store.upsertJob(execJob('perm-job'));
    const jobFile = join(dir, 'jobs', 'perm-job.json');
    const schemaFile = join(dir, 'jobs', 'perm-job.schema.json');
    expect(existsSync(jobFile)).toBe(true);
    expect(existsSync(schemaFile)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(jobFile).mode & 0o777).toBe(0o600);
      expect(statSync(schemaFile).mode & 0o777).toBe(0o600);
    }
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

  it('insertRun starts with pid unset and outputTruncated false', () => {
    const run = store.insertRun('test-job');
    expect(run.pid).toBeUndefined();
    expect(run.outputTruncated).toBe(false);
  });

  it('updateRun records the spawned child pid once known', () => {
    const run = store.insertRun('pid-job');
    store.updateRun(run.id, { status: 'running', pid: 4242 });
    expect(store.getRun(run.id)?.pid).toBe(4242);
  });

  it('updateRun sets outputTruncated when a run hits the output byte cap', () => {
    const run = store.insertRun('trunc-job');
    expect(store.getRun(run.id)?.outputTruncated).toBe(false);
    store.updateRun(run.id, { outputTruncated: true });
    expect(store.getRun(run.id)?.outputTruncated).toBe(true);
  });

  it('recordMissedRun inserts a terminal missed run with no pid', () => {
    const run = store.recordMissedRun('missed-job', 5000);
    expect(run.status).toBe('missed');
    expect(run.startedAt).toBe(5000);
    expect(run.endedAt).toBe(5000);
    expect(run.pid).toBeUndefined();
    const retrieved = store.getRun(run.id);
    expect(retrieved?.status).toBe('missed');
    expect(retrieved?.error).toContain('MISSED');
  });

  it('recordMissedRun accepts a custom note overriding the default error text', () => {
    const run = store.recordMissedRun('missed-job-2', 6000, 'MISSED: 500+ fires missed (capped)');
    expect(store.getRun(run.id)?.error).toBe('MISSED: 500+ fires missed (capped)');
  });

  it('recordMissedRun rows are subject to the same retention cap as any other terminal run', () => {
    const smallCapStore = new Store(join(dir, 'runs.db'), join(dir, 'jobs'), undefined, 2);
    smallCapStore.open();
    try {
      smallCapStore.recordMissedRun('missed-cap-job', 1);
      smallCapStore.recordMissedRun('missed-cap-job', 2);
      smallCapStore.recordMissedRun('missed-cap-job', 3);
      expect(smallCapStore.listRuns({ jobId: 'missed-cap-job' })).toHaveLength(2);
    } finally {
      smallCapStore.close();
    }
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

  it('listRuns filters by status, surfacing missed runs distinctly from success/failed', () => {
    const success = store.insertRun('job-status');
    store.updateRun(success.id, { status: 'success' });
    const failed = store.insertRun('job-status');
    store.updateRun(failed.id, { status: 'failed' });
    const missed = store.recordMissedRun('job-status', Date.now());

    expect(store.listRuns({ jobId: 'job-status', status: 'missed' }).map((r) => r.id)).toEqual([missed.id]);
    expect(store.listRuns({ jobId: 'job-status', status: 'success' }).map((r) => r.id)).toEqual([success.id]);
    expect(store.listRuns({ jobId: 'job-status' })).toHaveLength(3);
  });

  // ── Schedule state (missed-fire watermark) ──────────────────────────────────

  it('getScheduleState returns undefined for a job never observed live', () => {
    expect(store.getScheduleState('never-ticked')).toBeUndefined();
  });

  it('recordTick seeds and advances a job\'s last_tick_at watermark', () => {
    store.recordTick('tick-job', 1000);
    expect(store.getScheduleState('tick-job')?.lastTickAt).toBe(1000);
    store.recordTick('tick-job', 2000);
    expect(store.getScheduleState('tick-job')?.lastTickAt).toBe(2000);
  });

  it('recordTick defaults to now when no timestamp is passed', () => {
    const before = Date.now();
    store.recordTick('tick-job-default');
    const state = store.getScheduleState('tick-job-default');
    expect(state?.lastTickAt).toBeGreaterThanOrEqual(before);
  });

  // ── Orphan reconciliation (pid-based liveness) ──────────────────────────────

  it('reconcileOrphanRuns cancels a running run when no liveness checker is provided', () => {
    const run = store.insertRun('orphan-no-check');
    store.updateRun(run.id, { status: 'running', pid: 99999 });
    const result = store.reconcileOrphanRuns();
    expect(result.canceled).toBe(1);
    expect(result.adopted).toEqual([]);
    expect(store.getRun(run.id)?.status).toBe('canceled');
  });

  it('reconcileOrphanRuns adopts a running run whose checker confirms it is still alive', () => {
    const run = store.insertRun('orphan-alive');
    store.updateRun(run.id, { status: 'running', pid: 12345 });
    const result = store.reconcileOrphanRuns({ isRunAlive: () => true });
    expect(result.canceled).toBe(0);
    expect(result.adopted).toEqual([{ runId: run.id, jobId: 'orphan-alive', pid: 12345 }]);
    expect(store.getRun(run.id)?.status).toBe('running'); // untouched, not re-canceled
  });

  it('reconcileOrphanRuns cancels a running run whose checker reports it is dead or pid-reused', () => {
    const run = store.insertRun('orphan-dead');
    store.updateRun(run.id, { status: 'running', pid: 12345 });
    const result = store.reconcileOrphanRuns({ isRunAlive: () => false });
    expect(result.canceled).toBe(1);
    expect(result.adopted).toEqual([]);
    expect(store.getRun(run.id)?.status).toBe('canceled');
  });

  it('reconcileOrphanRuns adopts (favors not double-running) when the checker is inconclusive', () => {
    const run = store.insertRun('orphan-inconclusive');
    store.updateRun(run.id, { status: 'running', pid: 12345 });
    const result = store.reconcileOrphanRuns({ isRunAlive: () => undefined });
    expect(result.adopted).toHaveLength(1);
    expect(store.getRun(run.id)?.status).toBe('running');
  });

  it('reconcileOrphanRuns passes the run\'s recorded startedAt to the checker (pid-reuse guard input)', () => {
    const run = store.insertRun('orphan-startedat', 8080);
    store.updateRun(run.id, { status: 'running', pid: 555 });
    const seen: Array<[number, number]> = [];
    store.reconcileOrphanRuns({
      isRunAlive: (pid, startedAt) => {
        seen.push([pid, startedAt]);
        return true;
      },
    });
    expect(seen).toEqual([[555, 8080]]);
  });

  it('reconcileOrphanRuns always cancels queued runs regardless of any checker (no process was ever spawned)', () => {
    const run = store.insertRun('orphan-queued'); // stays queued, no pid
    const result = store.reconcileOrphanRuns({ isRunAlive: () => true });
    expect(result.canceled).toBe(1);
    expect(result.adopted).toEqual([]);
    expect(store.getRun(run.id)?.status).toBe('canceled');
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

  // ── Idempotent schema creation ──────────────────────────────────────────────

  it('open() is idempotent — re-open does not error or duplicate schema objects', () => {
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

  it('loadJobsFromDisk warns (not just debug-logs) with the file path and reason for an unreadable/malformed job file', () => {
    const { store: store2, events } = makeStoreWithEvents(dir);
    store2.open();
    const badPath = join(dir, 'jobs', 'bad.json');
    writeFileSync(badPath, 'not valid json{{{');
    store2.loadJobsFromDisk();
    store2.close();

    const warning = events.find((e) => e.level === 'warn' && e.message.includes('malformed job file'));
    expect(warning).toBeTruthy();
    expect((warning?.data as { filePath?: string } | undefined)?.filePath).toBe(badPath);
  });

  it('loadJobsFromDisk warns with the file path and reason for a job file failing schema validation', () => {
    const { store: store2, events } = makeStoreWithEvents(dir);
    store2.open();
    const invalidPath = join(dir, 'jobs', 'schema-invalid.json');
    writeFileSync(invalidPath, JSON.stringify({ id: 'schema-invalid' })); // missing required fields
    store2.loadJobsFromDisk();
    store2.close();

    const warning = events.find((e) => e.level === 'warn' && e.message.includes('schema validation'));
    expect(warning).toBeTruthy();
    expect((warning?.data as { filePath?: string } | undefined)?.filePath).toBe(invalidPath);
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

  it('logs eviction at info level (visible without --verbose) only when a run is actually evicted', () => {
    const { store: store2, events } = makeStoreWithEvents(dir);
    store2.open();
    try {
      // 100 runs exactly at the cap: no eviction should happen, so no info-level
      // eviction log should be emitted (steady state must stay silent).
      for (let i = 0; i < 100; i++) {
        const run = store2.insertRun('job-info-a', 1000 + i);
        store2.updateRun(run.id, { status: 'success' });
      }
      expect(events.filter((e) => e.level === 'info' && e.message.includes('Evicted'))).toHaveLength(0);

      // The 101st run pushes one run past the cap: exactly one eviction, so
      // exactly one info-level log, with the job id and evicted count.
      const run101 = store2.insertRun('job-info-a', 1000 + 100);
      store2.updateRun(run101.id, { status: 'success' });
      const evictionLogs = events.filter((e) => e.level === 'info' && e.message.includes('Evicted'));
      expect(evictionLogs).toHaveLength(1);
      expect(evictionLogs[0].data).toMatchObject({ jobId: 'job-info-a', evicted: 1 });
    } finally {
      store2.close();
    }
  });

  it('pruneAllJobsRunHistory startup backfill logs a concise info-level line with the number of runs pruned', () => {
    const dbPath = join(dir, 'runs.db');
    store.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec('BEGIN;');
    const insert = raw.prepare('INSERT INTO runs (id, job_id, started_at, status) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 150; i++) insert.run(`backfill-${i}`, 'job-backfill', i, 'success');
    raw.exec('COMMIT;');
    raw.close();

    const events: LogEvent[] = [];
    const logger = createLogger({ level: 'info', sink: (event) => events.push(event) });
    const backfillStore = new Store(dbPath, join(dir, 'jobs'), logger, 100);
    backfillStore.open();
    try {
      const evicted = backfillStore.pruneAllJobsRunHistory();
      expect(evicted).toBe(50);
      const backfillLogs = events.filter((e) => e.level === 'info' && e.message.toLowerCase().includes('pruned'));
      expect(backfillLogs).toHaveLength(1);
      expect(backfillLogs[0].message).toContain('50');
    } finally {
      backfillStore.close();
    }
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

  // node:sqlite rejects a single statement bound with more than 32766
  // parameters (SQLITE_LIMIT_VARIABLE_NUMBER). A prior unbatched
  // implementation built one "DELETE ... WHERE id IN (?,?,...)" per eviction
  // with a placeholder per row, which crashed the startup backfill on any
  // job whose backlog exceeded that count with "too many SQL variables" —
  // exactly the databases retention exists to fix, so the daemon could never
  // start again. This proves the batched eviction actually clears a backlog
  // well past that threshold, not a scaled-down proxy for it.
  it('evicts a backlog of far more than 32766 rows for a single job without hitting the SQLite bound-parameter limit', () => {
    const dbPath = join(dir, 'runs.db');
    // Close the fixture Store first so the schema has already been created,
    // but there is only one writer while we bulk-load raw rows below.
    store.close();

    const TOTAL_ROWS = 40_000;
    const CAP = 100;
    // Bulk insert directly via a raw connection, inside one transaction, so
    // seeding is fast and bypasses insertRun's own per-row pruneRunsForJob()
    // call (which would both be slow at this volume and self-defeating,
    // since it would keep truncating the table as we seed it).
    const raw = new DatabaseSync(dbPath);
    raw.exec('BEGIN;');
    const insert = raw.prepare('INSERT INTO runs (id, job_id, started_at, status) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < TOTAL_ROWS; i++) {
      insert.run(`bulk-${i}`, 'job-bulk', i, 'success');
    }
    raw.exec('COMMIT;');
    raw.close();

    const smallCapStore = new Store(dbPath, join(dir, 'jobs'), undefined, CAP);
    smallCapStore.open();
    try {
      const evicted = smallCapStore.pruneAllJobsRunHistory();
      expect(evicted).toBe(TOTAL_ROWS - CAP);
      expect(smallCapStore.listRuns({ jobId: 'job-bulk' })).toHaveLength(CAP);
    } finally {
      smallCapStore.close();
    }
  }, 20_000);

  // Retention is best-effort maintenance and must never break run recording:
  // a prune failure (disk full, corrupted rows, etc.) must be swallowed so
  // the run insert still succeeds ("run recorded, prune deferred").
  it('a failing prune does not fail the run insert', () => {
    const smallCapStore = new Store(join(dir, 'runs.db'), join(dir, 'jobs'), undefined, 1);
    smallCapStore.open();
    try {
      const first = smallCapStore.insertRun('job-prune-fail');
      smallCapStore.updateRun(first.id, { status: 'success' });

      // Corrupt the schema via a second raw connection so the next prune's
      // "DELETE FROM run_logs" throws, without touching the runs table (so
      // the run INSERT performed by insertRun itself still succeeds).
      const raw = new DatabaseSync(join(dir, 'runs.db'));
      raw.exec('DROP TABLE run_logs;');
      raw.close();

      // This insert pushes job-prune-fail's terminal-run count to 2, over
      // cap=1, triggering an eviction attempt that throws on the now-missing
      // run_logs table. insertRun must swallow that and still return the run.
      const second = smallCapStore.insertRun('job-prune-fail');
      expect(second.id).toBeTruthy();
      expect(smallCapStore.getRun(second.id)?.status).toBe('queued');
      expect(smallCapStore.getRun(first.id)).toBeTruthy(); // eviction never happened; run recorded despite failed prune
    } finally {
      smallCapStore.close();
    }
  });
});
