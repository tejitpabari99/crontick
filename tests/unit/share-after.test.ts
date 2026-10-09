import { describe, expect, it } from 'vitest';
import { remapAfterUpstreams, stripExportIds } from '../../src/share.js';

describe('share after refs', () => {
  it('export keeps ids only for referenced upstreams', () => {
    const rows = stripExportIds([
      { id: 'A', schedule: { kind: 'cron' } },
      { id: 'B', schedule: { kind: 'after', jobId: 'A' } },
    ]) as Array<{ id?: string }>;
    expect(rows[0].id).toBe('A');
    expect('id' in rows[1]).toBe(false);
  });
  it('import remaps after refs to new ids and leaves unknown refs', () => {
    const jobs = [
      { id: 'N1', schedule: { kind: 'cron' } },
      { id: 'N2', schedule: { kind: 'after', jobId: 'A' } },
      { id: 'N3', schedule: { kind: 'after', jobId: 'GONE' } },
    ] as Array<{ id: string; schedule: { kind: string; jobId?: string } }>;
    remapAfterUpstreams(jobs, ['A', 'B', undefined]);
    expect(jobs[1].schedule.jobId).toBe('N1');
    expect(jobs[2].schedule.jobId).toBe('GONE');
  });
});
