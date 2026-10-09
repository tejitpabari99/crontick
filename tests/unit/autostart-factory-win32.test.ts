import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAutostartBackend } from '../../src/autostart/index.js';
import { SchtasksBackend } from '../../src/autostart/schtasks.js';
import { renderTaskXml, parseTaskXml } from '../../src/autostart/taskxml.js';
import { AutostartService } from '../../src/autostart/service.js';
import type { AutostartDeps, AutostartSpec } from '../../src/autostart/types.js';

const spec: AutostartSpec = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  daemonScript: 'C:\\app\\dist\\daemon\\index.js',
  cliScript: 'C:\\app\\dist\\cli\\index.js',
  env: {},
};
const deps: AutostartDeps = {
  platform: 'win32',
  env: {},
  homedir: 'C:\\Users\\u',
  exec: async () => ({ code: 0, stdout: '', stderr: '' }),
  fs: {} as AutostartDeps['fs'],
};

describe('win32 factory', () => {
  it('returns the schtasks backend for win32', () => {
    const b = createAutostartBackend(deps);
    expect(b).toBeInstanceOf(SchtasksBackend);
    expect(b?.mechanism).toBe('schtasks');
  });
  it('still returns undefined for unsupported platforms', () => {
    expect(createAutostartBackend({ ...deps, platform: 'freebsd' })).toBeUndefined();
  });
});

describe('SchtasksBackend.expectedCommand', () => {
  const b = new SchtasksBackend(deps);
  it('without home', () => {
    expect(b.expectedCommand(spec)).toEqual([spec.cliScript, 'daemon', 'start']);
  });
  it('with home', () => {
    const s = { ...spec, env: { CRONTICK_HOME: 'D:\\my data\\ct' } };
    expect(b.expectedCommand(s)).toEqual([spec.cliScript, 'daemon', 'start', '--home', 'D:\\my data\\ct']);
  });
  it.each<Record<string, string>>([{}, { CRONTICK_HOME: 'D:\\my data\\ct' }])('matches parsed rendered Arguments (%j)', (env) => {
    const s = { ...spec, env };
    const parsed = parseTaskXml(renderTaskXml(s, 'S-1-5-21-1'));
    expect(parsed?.args).toEqual(b.expectedCommand(s));
  });
});

describe('win32 drift via AutostartService', () => {
  function status(registered: { nodePath: string; args: string[] }, env: Record<string, string>) {
    const backend = new SchtasksBackend(deps);
    backend.inspect = async () => ({ registered: true, command: { ...registered, env: {} } });
    backend.available = async () => ({ ok: true });
    const svc = new AutostartService({
      deps: { ...deps, env },
      backend,
      nodePath: spec.nodePath,
      daemonScript: spec.daemonScript,
      cliScript: spec.cliScript,
    } as never);
    return svc.status();
  }
  const base = { nodePath: spec.nodePath, args: [spec.cliScript, 'daemon', 'start'] };
  it('no false stale without home', async () => {
    expect((await status(base, {})).stale).toBe(false);
  });
  it('no false stale with home', async () => {
    const r = await status({ ...base, args: [...base.args, '--home', 'D:\\ct'] }, { CRONTICK_HOME: 'D:\\ct' });
    expect(r.stale).toBe(false);
  });
  it('stale on node change', async () => {
    expect((await status({ ...base, nodePath: 'C:\\other\\node.exe' }, {})).stale).toBe(true);
  });
  it('stale on cliScript change', async () => {
    expect((await status({ ...base, args: ['C:\\old\\cli.js', 'daemon', 'start'] }, {})).stale).toBe(true);
  });
  it('stale when home added after enable', async () => {
    expect((await status(base, { CRONTICK_HOME: 'D:\\ct' })).stale).toBe(true);
  });
});

describe('guard: no forbidden Windows mechanisms', () => {
  it('src/autostart never references reg.exe, PowerShell, wscript or conhost', () => {
    const dir = join(__dirname, '../../src/autostart');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      expect(readFileSync(join(dir, f), 'utf-8'), f).not.toMatch(/reg\.exe|powershell|wscript|conhost/i);
    }
  });
});
