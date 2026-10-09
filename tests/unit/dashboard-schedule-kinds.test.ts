/** SCHEDULE_KINDS registry + live preview wiring (SP04 Task 6): pure registry logic plus string-level shell assertions. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const js = readFileSync(resolve('src/dashboard/dashboard.js'), 'utf-8');
const css = readFileSync(resolve('src/dashboard/dashboard.css'), 'utf-8');

type Values = Record<string, string>;
interface Field { id: string; label: string; type: string; options?: string[]; required?: boolean }
interface Kind {
  kind: string; label: string; fields: Field[];
  toSchedule(v: Values): Record<string, unknown> | null;
  fromSchedule(s: Record<string, unknown>): Values;
  validate?(v: Values): string;
}
interface Pure {
  SCHEDULE_KINDS: Kind[];
  findScheduleKind(id: string): Kind | undefined;
  everySecFromInterval(n: string, unit: string): number | null;
  intervalFromEverySec(sec: number): { count: string; unit: string };
  toLocalInputValue(iso: string): string;
}
function loadPure(): Pure {
  const m = /\/\/ <editor-pure>([\s\S]*?)\/\/ <\/editor-pure>/.exec(js);
  expect(m).not.toBeNull();
  return new Function(`${m![1]}; return { SCHEDULE_KINDS, findScheduleKind, everySecFromInterval, intervalFromEverySec, toLocalInputValue };`)() as Pure;
}
const p = loadPure();
const kind = (id: string): Kind => p.findScheduleKind(id)!;

describe('SCHEDULE_KINDS registry', () => {
  it('ships cron, interval, one-shot, after with label and fields', () => {
    expect(p.SCHEDULE_KINDS.map((k) => k.kind)).toEqual(['cron', 'interval', 'one-shot', 'after']);
    for (const k of p.SCHEDULE_KINDS) {
      expect(k.label).toBeTruthy();
      expect(k.fields.length).toBeGreaterThan(0);
      expect(typeof k.toSchedule).toBe('function');
      expect(typeof k.fromSchedule).toBe('function');
    }
  });
  it('cron round-trips and is null when blank', () => {
    expect(kind('cron').toSchedule({ cron: ' 0 9 * * * ' })).toEqual({ kind: 'cron', cron: '0 9 * * *' });
    expect(kind('cron').toSchedule({ cron: '  ' })).toBeNull();
    expect(kind('cron').fromSchedule({ kind: 'cron', cron: '* * * * *' })).toEqual({ cron: '* * * * *' });
  });
  it('interval converts number+unit to everySec, optional startAt', () => {
    expect(p.everySecFromInterval('30', 'm')).toBe(1800);
    expect(p.everySecFromInterval('2', 'h')).toBe(7200);
    expect(p.everySecFromInterval('1', 'd')).toBe(86400);
    expect(p.everySecFromInterval('45', 's')).toBe(45);
    expect(p.everySecFromInterval('0', 'm')).toBeNull();
    expect(p.everySecFromInterval('abc', 'm')).toBeNull();
    expect(kind('interval').toSchedule({ count: '30', unit: 'm', startAt: '' })).toEqual({ kind: 'interval', everySec: 1800 });
    const s = kind('interval').toSchedule({ count: '1', unit: 'h', startAt: '2026-10-01T09:00' })!;
    expect(s.everySec).toBe(3600);
    expect(new Date(s.startAt as string).getTime()).toBe(new Date('2026-10-01T09:00').getTime());
    expect(kind('interval').toSchedule({ count: '', unit: 'm', startAt: '' })).toBeNull();
  });
  it('interval prefill picks the largest exact unit', () => {
    expect(p.intervalFromEverySec(1800)).toEqual({ count: '30', unit: 'm' });
    expect(p.intervalFromEverySec(7200)).toEqual({ count: '2', unit: 'h' });
    expect(p.intervalFromEverySec(172800)).toEqual({ count: '2', unit: 'd' });
    expect(p.intervalFromEverySec(90)).toEqual({ count: '90', unit: 's' });
    expect(p.intervalFromEverySec(2.5)).toEqual({ count: '2.5', unit: 's' });
    expect(kind('interval').fromSchedule({ kind: 'interval', everySec: 600 })).toMatchObject({ count: '10', unit: 'm', startAt: '' });
  });
  it('one-shot treats datetime-local as local time, like --at', () => {
    const s = kind('one-shot').toSchedule({ runAt: '2026-10-01T09:00' })!;
    expect(s.kind).toBe('one-shot');
    expect(new Date(s.runAt as string).getTime()).toBe(new Date('2026-10-01T09:00').getTime());
    expect(kind('one-shot').toSchedule({ runAt: '' })).toBeNull();
  });
  it('one-shot prefill renders runAt as local datetime-local text', () => {
    const iso = new Date(2026, 9, 1, 9, 5).toISOString();
    expect(p.toLocalInputValue(iso)).toBe('2026-10-01T09:05');
    expect(kind('one-shot').fromSchedule({ kind: 'one-shot', runAt: iso })).toEqual({ runAt: '2026-10-01T09:05' });
    expect(p.toLocalInputValue('garbage')).toBe('');
  });
  it('interval validate flags non-positive / non-numeric counts', () => {
    expect(kind('interval').validate!({ count: '0', unit: 'm', startAt: '' })).not.toBe('');
    expect(kind('interval').validate!({ count: '5', unit: 'm', startAt: '' })).toBe('');
  });
});

describe('schedule section shell (no per-kind branching)', () => {
  const hookSrc = js.slice(js.indexOf('const editorScheduleHook'), js.indexOf('const jobEditor ='));
  it('hook is registry driven and does not branch on kind names', () => {
    expect(hookSrc).toContain('SCHEDULE_KINDS');
    expect(hookSrc).not.toMatch(/['"](cron|interval|one-shot)['"]/);
  });
  it('debounces preview at 400ms with 5 fires, JSON content type, validate on blur', () => {
    expect(hookSrc).toMatch(/400/);
    expect(hookSrc).toContain('/api/schedules/preview');
    expect(hookSrc).toContain('/api/schedules/validate');
    expect(hookSrc).toContain("'Content-Type': 'application/json'");
    expect(hookSrc).toMatch(/n:\s*5/);
    expect(hookSrc).toContain('focusout');
  });
  it('has styles with rem units only', () => {
    expect(css).toMatch(/\.editor-preview/);
    expect(css).not.toMatch(/\.editor-preview[^{]*\{[^}]*\d+px/);
  });
});
