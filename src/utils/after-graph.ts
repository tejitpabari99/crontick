import type { Job } from '../schemas/job.js';

export interface AfterGraphError {
  code: 'AFTER_CYCLE' | 'AFTER_UPSTREAM_NOT_FOUND';
  message: string;
}

/**
 * Validates the `after` upstream chain of a (proposed) job against `jobs`. Each node has one
 * upstream, so this is a pointer walk: a cycle iff the walk reaches `job.id`; a visited set
 * guards against corrupt data that loops without including `job`. The proposed `job` replaces
 * any stored job with the same id. Only the first hop is checked for existence (a missing
 * ancestor is that ancestor's own problem). Returns undefined when valid or not an after-job.
 */
export function validateAfterGraph(job: Job, jobs: readonly Job[]): AfterGraphError | undefined {
  if (job.schedule.kind !== 'after') return undefined;
  const byId = new Map(jobs.map((j) => [j.id, j] as const));
  byId.set(job.id, job);
  const visited = new Set<string>();
  let cur: string = job.schedule.jobId;
  let first = true;
  for (;;) {
    if (cur === job.id) {
      return { code: 'AFTER_CYCLE', message: `After-trigger cycle: job ${job.id} is (transitively) its own upstream` };
    }
    if (visited.has(cur)) {
      return { code: 'AFTER_CYCLE', message: `After-trigger cycle in the upstream chain of job ${job.id} (at ${cur})` };
    }
    visited.add(cur);
    const next = byId.get(cur);
    if (!next) {
      return first
        ? { code: 'AFTER_UPSTREAM_NOT_FOUND', message: `Upstream job ${cur} not found` }
        : undefined;
    }
    first = false;
    if (next.schedule.kind !== 'after') return undefined;
    cur = next.schedule.jobId;
  }
}
