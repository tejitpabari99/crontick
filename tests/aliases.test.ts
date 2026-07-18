import { describe, it, expect } from 'vitest';
import { Scheduler, expandCronAlias } from '../src/daemon/scheduler.js';

describe('expandCronAlias', () => {
  it('@yearly → 0 0 1 1 *', () => expect(expandCronAlias('@yearly')).toBe('0 0 1 1 *'));
  it('@annually → 0 0 1 1 *', () => expect(expandCronAlias('@annually')).toBe('0 0 1 1 *'));
  it('@monthly → 0 0 1 * *', () => expect(expandCronAlias('@monthly')).toBe('0 0 1 * *'));
  it('@weekly → 0 0 * * 0', () => expect(expandCronAlias('@weekly')).toBe('0 0 * * 0'));
  it('@daily → 0 0 * * *', () => expect(expandCronAlias('@daily')).toBe('0 0 * * *'));
  it('@midnight → 0 0 * * *', () => expect(expandCronAlias('@midnight')).toBe('0 0 * * *'));
  it('@noon → 0 12 * * *', () => expect(expandCronAlias('@noon')).toBe('0 12 * * *'));
  it('@hourly → 0 * * * *', () => expect(expandCronAlias('@hourly')).toBe('0 * * * *'));
  it('@every_minute → * * * * *', () => expect(expandCronAlias('@every_minute')).toBe('* * * * *'));
  it('case-insensitive: @DAILY → 0 0 * * *', () => expect(expandCronAlias('@DAILY')).toBe('0 0 * * *'));
  it('non-alias passthrough', () => expect(expandCronAlias('0 9 * * 1')).toBe('0 9 * * 1'));
});

describe('Scheduler with cron aliases', () => {
  it('validateSchedule accepts @daily', () => {
    const s = new Scheduler();
    const result = s.validateSchedule({ kind: 'cron', cron: '@daily' });
    expect(result.ok).toBe(true);
  });

  it('previewNext with @daily returns 5 timestamps', () => {
    const s = new Scheduler();
    const next = s.previewNext({ kind: 'cron', cron: '@daily' }, { n: 5 });
    expect(next).toHaveLength(5);
    for (const t of next) {
      expect(() => new Date(t)).not.toThrow();
    }
  });

  it('previewNext with @hourly returns 3 timestamps', () => {
    const s = new Scheduler();
    const next = s.previewNext({ kind: 'cron', cron: '@hourly' }, { n: 3 });
    expect(next).toHaveLength(3);
  });
});
