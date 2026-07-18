import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/daemon/store.js';

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
      expect(store2.getRun(r1.id)?.error).toBe('daemon-restart');
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
      expect(store2.getRun(q1.id)?.error).toBe('daemon-restart');
      expect(store2.getRun(q2.id)?.status).toBe('canceled');
      expect(store2.getRun(r1.id)?.status).toBe('canceled');
      expect(store2.getRun(s1.id)?.status).toBe('success');
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
