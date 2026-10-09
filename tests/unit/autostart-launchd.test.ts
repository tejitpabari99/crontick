import { describe, expect, it } from 'vitest';
import { LaunchdBackend } from '../../src/autostart/launchd.js';
import { renderPlist, plistPaths, PLIST_LABEL } from '../../src/autostart/plist.js';
import type { AutostartDeps, AutostartSpec } from '../../src/autostart/types.js';
import { CrontickError } from '../../src/errors.js';

const spec: AutostartSpec = {
  nodePath: '/usr/local/bin/node',
  daemonScript: '/opt/crontick/dist/daemon/index.js',
  cliScript: '/opt/crontick/dist/cli/index.js',
  env: { CRONTICK_SUPERVISED: '1', CRONTICK_HOME: '/data/ct', PATH: '/usr/bin:/bin' },
};
const PLIST = `/Users/u/Library/LaunchAgents/${PLIST_LABEL}.plist`;
const L = '/bin/launchctl';
const target = `gui/501/${PLIST_LABEL}`;

function harness(opts: { files?: Record<string, string> } = {}) {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const calls: string[][] = [];
  const dirs: string[] = [];
  const modes: Record<string, number | undefined> = {};
  const respond: Record<string, Array<{ code: number; stdout?: string; stderr?: string }> | { code: number; stdout?: string; stderr?: string }> = {};
  let throwExec = false;
  const deps: AutostartDeps = {
    platform: 'darwin',
    env: {},
    homedir: '/Users/u',
    exec: async (file, args) => {
      calls.push([file, ...args]);
      if (throwExec) throw new Error('ENOENT');
      const key = args.join(' ');
      let r = respond[key] ?? { code: 0 };
      if (Array.isArray(r)) r = r.length > 1 ? r.shift()! : r[0]!;
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    fs: {
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw new Error('ENOENT');
        return v;
      },
      writeFile: async (p, d, o) => {
        files.set(p, String(d));
        modes[p] = o?.mode;
      },
      mkdir: async (p) => void dirs.push(p),
      rm: async (p) => void files.delete(p),
      access: async (p) => {
        if (!files.has(p)) throw new Error('ENOENT');
      },
    },
  };
  const backend = new LaunchdBackend(deps, () => 501, async () => {});
  return { backend, calls, files, dirs, modes, respond, setThrow: () => (throwExec = true) };
}

const rendered = renderPlist(spec, PLIST_LABEL, plistPaths(spec));
const NOT_LOADED = { code: 113, stderr: 'Could not find service' };

describe('LaunchdBackend.available', () => {
  it('ok when a GUI session exists', async () => {
    const h = harness();
    expect(await h.backend.available()).toEqual({ ok: true });
    expect(h.calls).toEqual([[L, 'print', 'gui/501']]);
  });
  it('not ok without getuid', async () => {
    const h = harness();
    const b = new LaunchdBackend({ ...({} as AutostartDeps) }, undefined);
    const r = await b.available();
    expect(r.ok).toBe(false);
    expect(h.calls).toEqual([]);
  });
  it('not ok without GUI session', async () => {
    const h = harness();
    h.respond['print gui/501'] = { code: 125, stderr: 'Domain does not support specified action' };
    const r = await h.backend.available();
    expect(r.ok).toBe(false);
  });
  it('not ok when launchctl cannot run', async () => {
    const h = harness();
    h.setThrow();
    const r = await h.backend.available();
    expect(r.ok).toBe(false);
  });
});

describe('LaunchdBackend.install', () => {
  it('fresh install', async () => {
    const h = harness();
    h.respond[`print ${target}`] = NOT_LOADED;
    const r = await h.backend.install(spec);
    expect(r).toEqual({ definitionPath: PLIST });
    expect(h.calls).toEqual([
      [L, 'print', target],
      [L, 'bootstrap', 'gui/501', PLIST],
      [L, 'enable', target],
    ]);
    expect(h.files.get(PLIST)).toBe(rendered);
    expect(h.modes[PLIST]).toBe(0o644);
    expect(h.dirs).toContain('/Users/u/Library/LaunchAgents');
    expect(h.dirs).toContain(plistPaths(spec).logsDir);
  });

  it('install when loaded boots out first', async () => {
    const h = harness();
    await h.backend.install(spec);
    expect(h.calls).toEqual([
      [L, 'print', target],
      [L, 'bootout', target],
      [L, 'bootstrap', 'gui/501', PLIST],
      [L, 'enable', target],
    ]);
  });

  it('identical re-install does not error', async () => {
    const h = harness({ files: { [PLIST]: rendered } });
    await expect(h.backend.install(spec)).resolves.toEqual({ definitionPath: PLIST });
    expect(h.files.get(PLIST)).toBe(rendered);
  });

  it('disable record: enable then retry bootstrap once', async () => {
    const h = harness();
    h.respond[`print ${target}`] = NOT_LOADED;
    h.respond[`bootstrap gui/501 ${PLIST}`] = [{ code: 5, stderr: 'Bootstrap failed: 5: Input/output error' }, { code: 0 }];
    h.respond['print-disabled gui/501'] = { code: 0, stdout: `disabled services = {\n\t"${PLIST_LABEL}" => disabled\n}` };
    await h.backend.install(spec);
    expect(h.calls).toEqual([
      [L, 'print', target],
      [L, 'bootstrap', 'gui/501', PLIST],
      [L, 'print-disabled', 'gui/501'],
      [L, 'enable', target],
      [L, 'bootstrap', 'gui/501', PLIST],
      [L, 'enable', target],
    ]);
  });

  it('bootstrap failure without disable record surfaces stderr', async () => {
    const h = harness();
    h.respond[`print ${target}`] = NOT_LOADED;
    h.respond[`bootstrap gui/501 ${PLIST}`] = { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' };
    h.respond['print-disabled gui/501'] = { code: 0, stdout: 'disabled services = {\n}' };
    const err = await h.backend.install(spec).catch((e) => e);
    expect(err).toBeInstanceOf(CrontickError);
    expect((err as Error).message).toContain('Input/output error');
    expect(h.calls.filter((c) => c[1] === 'bootstrap')).toHaveLength(1);
  });

  it('retry that still fails surfaces stderr', async () => {
    const h = harness();
    h.respond[`print ${target}`] = NOT_LOADED;
    h.respond[`bootstrap gui/501 ${PLIST}`] = { code: 5, stderr: 'still broken' };
    h.respond['print-disabled gui/501'] = { code: 0, stdout: `"${PLIST_LABEL}" => disabled` };
    const err = await h.backend.install(spec).catch((e) => e);
    expect(err).toBeInstanceOf(CrontickError);
    expect((err as Error).message).toContain('still broken');
    expect(h.calls.filter((c) => c[1] === 'bootstrap')).toHaveLength(2);
  });

  it('loaded label: retries bootstrap once after bootout race (regression)', async () => {
    const h = harness();
    h.respond[`bootstrap gui/501 ${PLIST}`] = [{ code: 5, stderr: 'Bootstrap failed: 5: Input/output error' }, { code: 0 }];
    await h.backend.install(spec);
    expect(h.calls.filter((c) => c[1] === 'bootstrap')).toHaveLength(2);
    expect(h.calls[h.calls.length - 1]).toEqual([L, 'enable', target]);
  });

  it('loaded label: bootstrap failing twice surfaces stderr', async () => {
    const h = harness();
    h.respond[`bootstrap gui/501 ${PLIST}`] = { code: 5, stderr: 'still racing' };
    h.respond['print-disabled gui/501'] = { code: 0, stdout: 'disabled services = {\n}' };
    const err = await h.backend.install(spec).catch((e) => e);
    expect((err as Error).message).toContain('still racing');
    expect(h.calls.filter((c) => c[1] === 'bootstrap')).toHaveLength(2);
  });

  it('never uses legacy verbs', async () => {
    const h = harness();
    await h.backend.install(spec);
    await h.backend.uninstall();
    for (const c of h.calls) expect(['load', 'unload', 'list']).not.toContain(c[1]);
  });
});

describe('LaunchdBackend.uninstall', () => {
  it('missing everything returns removed:false', async () => {
    const h = harness();
    h.respond[`bootout ${target}`] = { code: 113, stderr: 'Boot-out failed: 3: No such process' };
    expect(await h.backend.uninstall()).toEqual({ removed: false });
    expect(h.calls).toEqual([[L, 'bootout', target]]);
  });

  it('loaded and present: bootout, delete plist, removed:true', async () => {
    const h = harness({ files: { [PLIST]: rendered } });
    expect(await h.backend.uninstall()).toEqual({ removed: true });
    expect(h.calls).toEqual([[L, 'bootout', target]]);
    expect(h.files.has(PLIST)).toBe(false);
  });

  it('loaded but plist absent: removed:true', async () => {
    const h = harness();
    expect(await h.backend.uninstall()).toEqual({ removed: true });
  });

  it('plist present, not loaded: removed:true, no throw', async () => {
    const h = harness({ files: { [PLIST]: rendered } });
    h.respond[`bootout ${target}`] = { code: 113, stderr: 'Could not find service' };
    expect(await h.backend.uninstall()).toEqual({ removed: true });
    expect(h.files.has(PLIST)).toBe(false);
  });
});

describe('LaunchdBackend.inspect', () => {
  const PRINT_RUNNING = `${target} = {\n\tactive count = 1\n\tstate = running\n\tprogram = /usr/local/bin/node\n\tpid = 4242\n\tlast exit code = (never exited)\n}`;
  const PRINT_WAITING = `${target} = {\n\tstate = not running\n\tlast exit code = 1\n}`;
  const PD_ENABLED = `disabled services = {\n\t"com.apple.foo" => disabled\n\t"${PLIST_LABEL}" => enabled\n}`;
  const PD_DISABLED = `disabled services = {\n\t"${PLIST_LABEL}" => disabled\n}`;

  it('missing plist -> registered false, no throw', async () => {
    const h = harness();
    expect(await h.backend.inspect()).toEqual({ registered: false });
  });

  it('loaded + running + enabled', async () => {
    const h = harness({ files: { [PLIST]: rendered } });
    h.respond[`print ${target}`] = { code: 0, stdout: PRINT_RUNNING };
    h.respond['print-disabled gui/501'] = { code: 0, stdout: PD_ENABLED };
    const r = await h.backend.inspect();
    expect(r).toMatchObject({ registered: true, enabledInManager: true, active: true, definitionPath: PLIST });
    expect(r.command?.nodePath).toBe(spec.nodePath);
    expect(r.command?.args).toEqual([spec.daemonScript]);
    expect(r.notes ?? []).toEqual([]);
    expect(h.calls.every((c) => c[1] === 'print' || c[1] === 'print-disabled')).toBe(true);
  });

  it('loaded but not running -> active false', async () => {
    const h = harness({ files: { [PLIST]: rendered } });
    h.respond[`print ${target}`] = { code: 0, stdout: PRINT_WAITING };
    h.respond['print-disabled gui/501'] = { code: 0, stdout: PD_ENABLED };
    expect((await h.backend.inspect()).active).toBe(false);
  });

  it('unloaded service -> active false, Login Items note', async () => {
    const h = harness({ files: { [PLIST]: rendered } });
    h.respond[`print ${target}`] = NOT_LOADED;
    h.respond['print-disabled gui/501'] = { code: 0, stdout: PD_ENABLED };
    const r = await h.backend.inspect();
    expect(r).toMatchObject({ registered: true, active: false });
    expect(r.notes?.join(' ')).toContain('Login Items & Extensions');
  });

  it('disabled record -> enabledInManager false', async () => {
    const h = harness({ files: { [PLIST]: rendered } });
    h.respond[`print ${target}`] = NOT_LOADED;
    h.respond['print-disabled gui/501'] = { code: 0, stdout: PD_DISABLED };
    expect((await h.backend.inspect()).enabledInManager).toBe(false);
  });

  it('garbage print output -> active undefined + note, no throw', async () => {
    const h = harness({ files: { [PLIST]: rendered } });
    h.respond[`print ${target}`] = { code: 0, stdout: '\u0000<<garbage>>' };
    h.respond['print-disabled gui/501'] = { code: 0, stdout: 'garbage' };
    const r = await h.backend.inspect();
    expect(r.registered).toBe(true);
    expect(r.active).toBeUndefined();
    expect(r.notes?.join(' ')).toMatch(/parse/i);
  });

  it('exec throwing and unparseable plist never throw', async () => {
    const h = harness({ files: { [PLIST]: 'not a plist' } });
    h.setThrow();
    const r = await h.backend.inspect();
    expect(r.registered).toBe(true);
    expect(r.command).toBeUndefined();
    expect(r.active).toBeUndefined();
    expect(r.enabledInManager).toBeUndefined();
    expect(r.notes?.length).toBeGreaterThan(0);
  });
});
