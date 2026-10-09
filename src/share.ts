/** Pure helpers for `share export` / `share import`. */
import { resolve } from 'node:path';

/**
 * Final export path: the given name is kept unchanged when it already ends in
 * `.json` (case-insensitive), else `.json` is appended (`try_me.txt` becomes
 * `try_me.txt.json`, `backup` becomes `backup.json`). Relative paths resolve
 * against `cwd`.
 */
export function resolveExportPath(out: string, cwd: string): string {
  return resolve(cwd, /\.json$/i.test(out) ? out : `${out}.json`);
}

interface ShareJobLike {
  id: string;
  schedule: { kind: string; jobId?: string };
}

/**
 * Export rows: ids are omitted except for jobs that another exported job runs
 * `after`, so intra-export `after` chains can be re-linked on import.
 */
export function stripExportIds<T extends ShareJobLike>(jobs: readonly T[]): Array<Omit<T, 'id'> | T> {
  const referenced = new Set(jobs.filter((j) => j.schedule.kind === 'after' && j.schedule.jobId).map((j) => j.schedule.jobId));
  return jobs.map((job) => {
    if (referenced.has(job.id)) return job;
    const { id: _id, ...rest } = job;
    void _id;
    return rest;
  });
}

/**
 * Import: every job minted a new id, so rewrite `after` upstream refs that point
 * at an exported id to the new id. `oldIds[i]` is the file id of `jobs[i]`.
 * Refs to ids not in the file are left alone (the daemon handles dangling refs).
 */
export function remapAfterUpstreams<T extends { id: string; schedule: { kind: string; jobId?: string } }>(
  jobs: readonly T[],
  oldIds: ReadonlyArray<string | undefined>,
): void {
  const map = new Map<string, string>();
  jobs.forEach((job, i) => {
    const old = oldIds[i];
    if (old) map.set(old, job.id);
  });
  for (const job of jobs) {
    if (job.schedule.kind === 'after' && job.schedule.jobId && map.has(job.schedule.jobId)) {
      job.schedule.jobId = map.get(job.schedule.jobId);
    }
  }
}
