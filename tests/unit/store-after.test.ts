import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store, validateAfterGraph } from '../../src/daemon/store.js';
import { createLogger, type LogEvent } from '../../src/logger.js';
import type { Job } from '../../src/schemas/job.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const MISSING = '00000000-0000-4000-8000-0000000000ff';

function cronJob(id: string): Job {
  return { catchUp: false,
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: { kind: 'prompt', prompt: 'p', args: [], reuseSession: false },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 30 },
  };
}

function afterJob(id: string, upstream: string, status: 'success' | 'failure' | 'any' = 'success'): Job {
  return { ...cronJob(id), schedule: { kind: 'after', jobId: upstream, status } };
}

describe('validateAfterGraph', () => {
  it('returns undefined for non-after jobs and valid chains', () => {
    expect(validateAfterGraph(cronJob(A), [])).toBeUndefined();
    expect(validateAfterGraph(afterJob(B, A), [cronJob(A)])).toBeUndefined();
  });

  it('detects self reference', () => {
    expect(validateAfterGraph(afterJob(A, A), [])?.code).toBe('AFTER_CYCLE');
  });

  it('detects 2-node cycle (proposed job replaces stored copy)', () => {
    const a = afterJob(A, B);
    const b = afterJob(B, A);
    expect(validateAfterGraph(a, [cronJob(A), b])?.code).toBe('AFTER_CYCLE');
  });

  it('detects 3-node cycle', () => {
    const a = afterJob(A, C);
    expect(validateAfterGraph(a, [afterJob(B, A), afterJob(C, B)])?.code).toBe('AFTER_CYCLE');
  });

  it('reports dangling upstream', () => {
    expect(validateAfterGraph(afterJob(B, MISSING), [])?.code).toBe('AFTER_UPSTREAM_NOT_FOUND');
  });

  it('terminates on a corrupt cycle that does not include the job', () => {
    const r = validateAfterGraph(afterJob(A, B), [afterJob(B, C), afterJob(C, B)]);
    expect(r?.code).toBe('AFTER_CYCLE');
  });
});

describe('Store after-trigger support', () => {
  let dir: string;
  let store: Store;
  let events: LogEvent[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crontick-test-'));
    mkdirSync(join(dir, 'jobs'), { recursive: true });
    events = [];
    const logger = createLogger({ level: 'debug', sink: (e) => events.push(e) });
    store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'), logger);
    store.open();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('listDependents returns only jobs whose after-schedule points at the id', () => {
    store.upsertJob(cronJob(A));
    store.upsertJob(afterJob(B, A));
    store.upsertJob(afterJob(C, B));
    expect(store.listDependents(A).map((j) => j.id)).toEqual([B]);
    expect(store.listDependents(B).map((j) => j.id)).toEqual([C]);
    expect(store.listDependents(C)).toEqual([]);
  });

  it('persists and reads run trigger_json', () => {
    const run = store.insertRun(A);
    expect(store.getRunTrigger(run.id)).toBeUndefined();
    store.setRunTrigger(run.id, { kind: 'after', upstream: { runId: 'r1', jobId: B } });
    expect(store.getRunTrigger(run.id)).toEqual({ kind: 'after', upstream: { runId: 'r1', jobId: B } });
  });

  it('runs table has a nullable trigger_json column', () => {
    const db = new DatabaseSync(join(dir, 'runs.db'));
    const cols = db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string; notnull: number }>;
    db.close();
    const col = cols.find((c) => c.name === 'trigger_json');
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0);
  });

  it('loadJobsFromDisk flags dangling and cyclic after-jobs as broken, loads them, warns', () => {
    const jobs = [cronJob(A), afterJob(B, MISSING), afterJob(C, '00000000-0000-4000-8000-0000000000dd'), afterJob('00000000-0000-4000-8000-0000000000dd', C)];
    for (const j of jobs) writeFileSync(join(dir, 'jobs', `${j.id}.json`), JSON.stringify(j));
    store.loadJobsFromDisk();
    expect(store.listJobs()).toHaveLength(4);
    const broken = store.getBrokenJobs();
    expect(broken.get(B)?.code).toBe('AFTER_UPSTREAM_NOT_FOUND');
    expect(broken.get(C)?.code).toBe('AFTER_CYCLE');
    expect(broken.has(A)).toBe(false);
    expect(store.isJobBroken(B)).toBe(true);
    expect(store.isJobBroken(A)).toBe(false);
    expect(events.some((e) => e.level === 'warn' && /broken/i.test(e.message))).toBe(true);
  });

  it('reload clears broken flag once the graph is repaired', () => {
    const b = afterJob(B, MISSING);
    writeFileSync(join(dir, 'jobs', `${b.id}.json`), JSON.stringify(b));
    store.loadJobsFromDisk();
    expect(store.isJobBroken(B)).toBe(true);
    writeFileSync(join(dir, 'jobs', `${A}.json`), JSON.stringify(cronJob(A)));
    writeFileSync(join(dir, 'jobs', `${B}.json`), JSON.stringify(afterJob(B, A)));
    store.loadJobsFromDisk();
    expect(store.isJobBroken(B)).toBe(false);
  });

  it('regression: broken state follows upsert/delete without a reload (repaired job is not inert)', () => {
    const b = afterJob(B, MISSING);
    store.upsertJob(b);
    expect(store.isJobBroken(B)).toBe(true);
    store.upsertJob(afterJob(B, A)); // repoint to an upstream that does not exist yet
    expect(store.isJobBroken(B)).toBe(true);
    store.upsertJob(cronJob(A));
    expect(store.isJobBroken(B)).toBe(false);
    expect(store.getBrokenJobs().size).toBe(0);
    store.deleteJob(A);
    expect(store.isJobBroken(B)).toBe(true);
  });
});
