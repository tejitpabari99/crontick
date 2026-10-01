import { afterEach, describe, expect, it } from 'vitest';
import { isAbsolute, join, resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveJobLogPath } from '../../src/daemon/job-log-file.js';

describe('resolveJobLogPath', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const home = () => { const d = mkdtempSync(join(tmpdir(), 'crontick-logpath-')); dirs.push(d); return d; };

  it('returns an absolute per-job path under <dataDir>/logs by default', () => {
    const d = home();
    const p = resolveJobLogPath('job-1', { CRONTICK_HOME: d });
    expect(isAbsolute(p!)).toBe(true);
    expect(p).toBe(resolve(join(d, 'logs', 'job-1.log')));
  });

  it('sanitizes the job id so it cannot escape the log dir', () => {
    const d = home();
    expect(resolveJobLogPath('../evil/x', { CRONTICK_HOME: d })).toBe(resolve(join(d, 'logs', '.._evil_x.log')));
  });

  it('honors logging.dir and returns null when file logging is disabled', () => {
    const d = home();
    const custom = join(d, 'custom');
    writeFileSync(join(d, 'config.json'), JSON.stringify({ logging: { dir: custom } }));
    expect(resolveJobLogPath('j', { CRONTICK_HOME: d })).toBe(resolve(join(custom, 'j.log')));
    writeFileSync(join(d, 'config.json'), JSON.stringify({ logging: { fileEnabled: false } }));
    expect(resolveJobLogPath('j', { CRONTICK_HOME: d })).toBeNull();
  });
});
