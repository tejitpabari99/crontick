import { describe, expect, it } from 'vitest';
import { formatDurationSec, formatLocalIso, formatRunsTable, truncateText, RUN_TABLE_ERROR_MAX } from '../../src/run-format.js';
import type { RunRecord } from '../../src/client.js';

const run = (overrides: Partial<RunRecord>): RunRecord => ({
  id: 'run-1', jobId: 'job-1', startedAt: Date.UTC(2026, 8, 29, 4, 0, 0), status: 'success', outputTruncated: false, ...overrides,
});

describe('run formatting', () => {
  it('formats local ISO timestamps with an offset and never raw epoch ms', () => {
    const text = formatLocalIso(Date.UTC(2026, 8, 29, 4, 0, 0));
    expect(text).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    expect(new Date(text).getTime()).toBe(Date.UTC(2026, 8, 29, 4, 0, 0));
    expect(formatLocalIso(undefined)).toBe('-');
  });

  it('formats durations in seconds', () => {
    expect(formatDurationSec(187_000)).toBe('187s');
    expect(formatDurationSec(1_234)).toBe('1.23s');
    expect(formatDurationSec(0)).toBe('0s');
    expect(formatDurationSec(undefined)).toBe('-');
  });

  it('truncates long error text in the table but leaves the record untouched', () => {
    const error = `Failed to authenticate. ${'x'.repeat(300)}`;
    const record = run({ status: 'failed', error, durationMs: 187_000, endedAt: Date.UTC(2026, 8, 29, 4, 3, 7), exitCode: 1 });
    const table = formatRunsTable([record]);
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/^RUN\s+JOB\s+STATUS\s+STARTED\s+ENDED\s+DURATION\s+EXIT\s+ERROR$/);
    expect(lines[1]).toContain('187s');
    expect(lines[1]).toContain('…');
    expect(lines[1]!.length).toBeLessThan(300);
    expect(truncateText(error).length).toBe(RUN_TABLE_ERROR_MAX);
    expect(record.error).toBe(error);
  });
});
