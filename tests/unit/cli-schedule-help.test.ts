import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEDULE_FLAGS, scheduleFooter } from '../../src/constants/cli-schedule.js';

const CLI = resolve('dist/cli/index.js');
const help = (args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args, '--help'], { encoding: 'utf-8', timeout: 30_000 }).stdout;
const flat = (s: string) => s.replace(/\s*\n\s*/g, ' ').replace(/ {2,}/g, ' ');

describe('schedule flag help', () => {
  const strings = SCHEDULE_FLAGS.map((f) => f.description);

  it('jobs new shows exact strings and constant-derived footer', () => {
    const out = flat(help(['jobs', 'new']));
    for (const s of strings) expect(out).toContain(s);
    expect(out).not.toContain('exactly one of --cron/--every/--at');
    expect(out).toContain(flat(scheduleFooter()).trim());
    expect(out).toContain('--cron, --every, --at');
  });

  it('jobs update shows the strings and no footer', () => {
    const out = flat(help(['jobs', 'update']));
    for (const s of strings) expect(out).toContain(s);
    expect(out).not.toContain('How to schedule');
  });
});
