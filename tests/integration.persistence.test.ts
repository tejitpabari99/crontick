import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/daemon/store.js';
import { ORPHAN_RUN_ERROR_CODE, ORPHAN_RUN_ERROR_MESSAGE } from '../src/errors.js';

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crontick-persist-'));
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  return dir;
}

describe('Integration: persistence and orphan run reconciler', () => {
  it('reconcileOrphanRuns cancels all running runs on restart', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'runs.db');
    const jobsPath = join(dir, 'jobs');

    try {
      const store1 = new Store(dbPath, jobsPath);
      store1.open();
      const r1 = store1.insertRun('job-a');
      const r2 = store1.insertRun('job-b');
      store1.updateRun(r1.id, { status: 'running' });
      store1.updateRun(r2.id, { status: 'running' });
      const r3 = store1.insertRun('job-c');
      store1.updateRun(r3.id, { status: 'success' });
      store1.close();

      const store2 = new Store(dbPath, jobsPath);
      store2.open();
      const reconciled = store2.reconcileOrphanRuns();
      expect(reconciled).toBe(2);
      expect(store2.getRun(r1.id)?.status).toBe('canceled');
      expect(store2.getRun(r1.id)?.error).toBe(ORPHAN_RUN_ERROR_MESSAGE);
      expect(store2.getRun(r1.id)?.error?.startsWith(ORPHAN_RUN_ERROR_CODE)).toBe(true);
      expect(store2.getRun(r2.id)?.status).toBe('canceled');
      expect(store2.getRun(r3.id)?.status).toBe('success');
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reconcileOrphanRuns returns 0 when no orphans exist', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'runs.db');
    const jobsPath = join(dir, 'jobs');
    try {
      const store = new Store(dbPath, jobsPath);
      store.open();
      const run = store.insertRun('job-x');
      store.updateRun(run.id, { status: 'success' });
      const count = store.reconcileOrphanRuns();
      expect(count).toBe(0);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reconcileOrphanRuns is idempotent', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'runs.db');
    const jobsPath = join(dir, 'jobs');
    try {
      const store = new Store(dbPath, jobsPath);
      store.open();
      const run = store.insertRun('job-y');
      store.updateRun(run.id, { status: 'running' });
      const first = store.reconcileOrphanRuns();
      expect(first).toBe(1);
      const second = store.reconcileOrphanRuns();
      expect(second).toBe(0);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reconcileOrphanRuns cancels queued runs on restart', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'runs.db');
    const jobsPath = join(dir, 'jobs');
    try {
      const store1 = new Store(dbPath, jobsPath);
      store1.open();
      const q1 = store1.insertRun('job-q1'); // stays queued
      const q2 = store1.insertRun('job-q2'); // stays queued
      const r1 = store1.insertRun('job-r1');
      store1.updateRun(r1.id, { status: 'running' });
      const s1 = store1.insertRun('job-s1');
      store1.updateRun(s1.id, { status: 'success' });
      store1.close();

      const store2 = new Store(dbPath, jobsPath);
      store2.open();
      const reconciled = store2.reconcileOrphanRuns();
      expect(reconciled).toBe(3); // q1 + q2 + r1
      expect(store2.getRun(q1.id)?.status).toBe('canceled');
      expect(store2.getRun(q1.id)?.error).toBe(ORPHAN_RUN_ERROR_MESSAGE);
      expect(store2.getRun(q2.id)?.status).toBe('canceled');
      expect(store2.getRun(r1.id)?.status).toBe('canceled');
      expect(store2.getRun(s1.id)?.status).toBe('success');
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Run retention: startup backfill ──────────────────────────────────────────

  it('pruneAllJobsRunHistory truncates a pre-existing oversized database on startup', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'runs.db');
    const jobsPath = join(dir, 'jobs');
    try {
      // Simulate "a database that predates this feature": populate it via a
      // Store with a very large cap so insertRun's own pruning is a no-op,
      // leaving all 10 terminal runs in place.
      const unboundedStore = new Store(dbPath, jobsPath, undefined, 1_000_000);
      unboundedStore.open();
      const runIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const run = unboundedStore.insertRun('job-legacy', i);
        unboundedStore.updateRun(run.id, { status: 'success' });
        runIds.push(run.id);
      }
      unboundedStore.close();

      // Reopen with a small cap and run the startup backfill pass directly.
      const smallCapStore = new Store(dbPath, jobsPath, undefined, 4);
      smallCapStore.open();
      const pruned = smallCapStore.pruneAllJobsRunHistory();
      expect(pruned).toBe(6);
      expect(smallCapStore.listRuns({ jobId: 'job-legacy' })).toHaveLength(4);

      // Idempotent: a second pass finds nothing left to prune.
      expect(smallCapStore.pruneAllJobsRunHistory()).toBe(0);
      smallCapStore.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pruneAllJobsRunHistory never evicts an in-flight run from the oversized-database backfill', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'runs.db');
    const jobsPath = join(dir, 'jobs');
    try {
      const unboundedStore = new Store(dbPath, jobsPath, undefined, 1_000_000);
      unboundedStore.open();
      for (let i = 0; i < 10; i++) {
        const run = unboundedStore.insertRun('job-legacy2', i);
        unboundedStore.updateRun(run.id, { status: 'success' });
      }
      // Oldest run for the job, left queued — must survive the backfill regardless of age.
      const queuedRun = unboundedStore.insertRun('job-legacy2', -1);
      unboundedStore.close();

      const smallCapStore = new Store(dbPath, jobsPath, undefined, 4);
      smallCapStore.open();
      smallCapStore.pruneAllJobsRunHistory();
      expect(smallCapStore.getRun(queuedRun.id)?.status).toBe('queued');
      smallCapStore.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A backfill failure (disk full, corrupted rows, etc.) is best-effort
  // maintenance and must be logged, not thrown — the real daemon startup
  // path (src/daemon/index.ts main()) wraps pruneAllJobsRunHistory() in a
  // try/catch specifically so this can never block the daemon from starting
  // and serving already-scheduled jobs.
  it('a failing backfill does not throw — it is swallowed so startup can continue', () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, 'runs.db');
    const jobsPath = join(dir, 'jobs');
    try {
      const unboundedStore = new Store(dbPath, jobsPath, undefined, 1_000_000);
      unboundedStore.open();
      for (let i = 0; i < 10; i++) {
        const run = unboundedStore.insertRun('job-backfill-fail', i);
        unboundedStore.updateRun(run.id, { status: 'success' });
      }
      unboundedStore.close();

      // Corrupt the schema so the backfill's eviction throws on the missing
      // run_logs table for every job it encounters.
      const raw = new DatabaseSync(dbPath);
      raw.exec('DROP TABLE run_logs;');
      raw.close();

      const smallCapStore = new Store(dbPath, jobsPath, undefined, 4);
      smallCapStore.open();
      try {
        expect(() => smallCapStore.pruneAllJobsRunHistory()).not.toThrow();
        // The prune failed internally, so nothing was evicted — the backfill
        // degrades to a no-op rather than silently reporting success.
        expect(smallCapStore.listRuns({ jobId: 'job-backfill-fail' })).toHaveLength(10);
      } finally {
        smallCapStore.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
