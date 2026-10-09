import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describeSchedule } from '../../src/utils/schedule-label.js';

const UP = '12345678-1111-4111-8111-111111111111';
const lookup = (id: string) => (id === UP ? { alias: 'etl' } : undefined);

describe('describeSchedule', () => {
  it('labels after with alias', () => {
    expect(describeSchedule({ kind: 'after', jobId: UP, status: 'success' }, lookup)).toBe('after etl (on success)');
    expect(describeSchedule({ kind: 'after', jobId: UP, status: 'any' }, lookup)).toBe('after etl (on any)');
  });
  it('falls back to id8 when upstream has no alias', () => {
    expect(describeSchedule({ kind: 'after', jobId: UP, status: 'success' }, () => ({}))).toBe('after 12345678 (on success)');
  });
  it('labels a dangling upstream as missing', () => {
    expect(describeSchedule({ kind: 'after', jobId: '99999999-1111-4111-8111-111111111111', status: 'success' }, lookup)).toBe('after 99999999 (missing)');
  });
  it('labels time schedules', () => {
    expect(describeSchedule({ kind: 'cron', cron: '0 9 * * *' }, lookup)).toBe('0 9 * * *');
    expect(describeSchedule({ kind: 'interval', everySec: 60 }, lookup)).toBe('every 60s');
    expect(describeSchedule({ kind: 'one-shot', runAt: '2026-01-01T00:00:00.000Z' }, lookup)).toBe('once at 2026-01-01T00:00:00.000Z');
  });
});

describe('dashboard after entry and display sites', () => {
  const js = readFileSync(resolve('src/dashboard/dashboard.js'), 'utf-8');
  const dash = readFileSync(resolve('src/dashboard.ts'), 'utf-8');
  const cli = readFileSync(resolve('src/cli/index.ts'), 'utf-8');
  const client = readFileSync(resolve('src/client.ts'), 'utf-8');
  it('registers an after SCHEDULE_KINDS entry', () => {
    expect(js).toMatch(/kind: 'after'/);
    expect(js).toMatch(/optionsFrom: 'jobs'/);
  });
  it('dashboard payload uses describeSchedule and null nextRunAt for after', () => {
    expect(dash).toContain('describeSchedule');
    expect(dash).toMatch(/isTimeSchedule\(job\.schedule\)/);
  });
  it('CLI list/get and jobSchedule use the label', () => {
    expect(cli).toContain('describeSchedule');
    expect(client).toContain('triggered after');
  });
});
