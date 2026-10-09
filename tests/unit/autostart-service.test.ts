import { describe, expect, it, vi } from 'vitest';
import { AutostartService, createAutostartBackend } from '../../src/autostart/index.js';
import type { AutostartBackend, AutostartDeps, BackendInspection } from '../../src/autostart/types.js';
import { CrontickError } from '../../src/errors.js';

const NODE = '/usr/bin/node';
const SCRIPT = '/opt/crontick/dist/daemon/index.js';
const CLI = '/opt/crontick/dist/cli/index.js';

function mkDeps(over: Partial<AutostartDeps> = {}, missing: string[] = []): AutostartDeps {
  return {
    platform: 'linux',
    env: { PATH: '/usr/bin:/bin' },
    homedir: '/home/u',
    exec: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    fs: {
      readFile: vi.fn(async () => ''),
      writeFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => undefined),
      rm: vi.fn(async () => {}),
      access: vi.fn(async (p: string) => {
        if (missing.includes(p)) throw new Error('ENOENT');
      }),
    },
    ...over,
  };
}

function mkBackend(over: Partial<AutostartBackend> & { inspection?: BackendInspection } = {}): AutostartBackend {
  const { inspection, ...rest } = over;
  return {
    mechanism: 'systemd-user',
    available: async () => ({ ok: true }),
    install: vi.fn(async () => ({ definitionPath: '/home/u/.config/systemd/user/crontick.service' })),
    uninstall: vi.fn(async () => ({ removed: true })),
    inspect: async () => inspection ?? { registered: false },
    ...rest,
  };
}

function svc(o: { deps?: AutostartDeps; backend?: AutostartBackend | undefined; node?: string; script?: string } = {}) {
  const deps = o.deps ?? mkDeps();
  return new AutostartService({
    deps,
    backend: 'backend' in o ? o.backend : mkBackend(),
    nodePath: o.node ?? NODE,
    daemonScript: o.script ?? SCRIPT,
    cliScript: CLI,
  });
}

const registered = (over: Partial<NonNullable<BackendInspection['command']>> = {}): BackendInspection => ({
  registered: true,
  enabledInManager: true,
  active: true,
  definitionPath: '/d/crontick.service',
  command: { nodePath: NODE, args: [SCRIPT], env: { CRONTICK_SUPERVISED: '1', PATH: '/usr/bin:/bin' }, ...over },
});

describe('createAutostartBackend', () => {
  it('returns undefined for platforms without a factory', () => {
    expect(createAutostartBackend(mkDeps({ platform: 'freebsd' }))).toBeUndefined();
  });
  it('uses the factory for the injected platform', () => {
    const b = mkBackend();
    expect(createAutostartBackend(mkDeps(), { linux: () => b })).toBe(b);
    expect(createAutostartBackend(mkDeps({ platform: 'darwin' }), { linux: () => b })).toBeUndefined();
  });
});

describe('AutostartService.buildSpec', () => {
  it('sets supervised, PATH snapshot, scripts; omits CRONTICK_HOME when unset', () => {
    const spec = svc().buildSpec();
    expect(spec).toEqual({
      nodePath: NODE,
      daemonScript: SCRIPT,
      cliScript: CLI,
      env: { CRONTICK_SUPERVISED: '1', PATH: '/usr/bin:/bin' },
    });
  });
  it('includes CRONTICK_HOME when set', () => {
    const spec = svc({ deps: mkDeps({ env: { PATH: '/p', CRONTICK_HOME: '/data' } }) }).buildSpec();
    expect(spec.env).toEqual({ CRONTICK_SUPERVISED: '1', CRONTICK_HOME: '/data', PATH: '/p' });
  });
});

describe('AutostartService.status', () => {
  it('unsupported platform: supported:false with reason, never throws', async () => {
    const s = await svc({ backend: undefined, deps: mkDeps({ platform: 'freebsd' }) }).status();
    expect(s.supported).toBe(false);
    expect(s.enabled).toBe(false);
    expect(s.reason).toMatch(/freebsd/);
  });
  it('unavailable backend: supported:false with its reason', async () => {
    const b = mkBackend({ available: async () => ({ ok: false, reason: 'no user bus' }) });
    const s = await svc({ backend: b }).status();
    expect(s).toMatchObject({ supported: false, enabled: false, reason: 'no user bus', mechanism: 'systemd-user' });
  });
  it('not registered', async () => {
    const s = await svc().status();
    expect(s).toMatchObject({ supported: true, enabled: false, stale: false });
  });
  it('registered and current: not stale, no PATH hint', async () => {
    const s = await svc({ backend: mkBackend({ inspection: registered() }) }).status();
    expect(s).toMatchObject({ supported: true, enabled: true, active: true, stale: false, staleReasons: [] });
    expect(s.command).toBe(`${NODE} ${SCRIPT}`);
    expect(s.hints).toEqual([]);
  });
  it('drift on node path change', async () => {
    const s = await svc({ backend: mkBackend({ inspection: registered() }), node: '/new/node' }).status();
    expect(s.stale).toBe(true);
    expect(s.staleReasons.join()).toMatch(/node path/);
    expect(s.hints.join()).toMatch(/autostart enable/);
  });
  it('drift on daemon script change', async () => {
    const s = await svc({ backend: mkBackend({ inspection: registered() }), script: '/other/daemon/index.js' }).status();
    expect(s.stale).toBe(true);
    expect(s.staleReasons.join()).toMatch(/command changed/);
  });
  it('drift on CRONTICK_HOME change (set later, changed, removed)', async () => {
    const b = mkBackend({ inspection: registered() });
    const added = await svc({ backend: b, deps: mkDeps({ env: { PATH: '/usr/bin:/bin', CRONTICK_HOME: '/data' } }) }).status();
    expect(added.stale).toBe(true);
    expect(added.staleReasons.join()).toMatch(/CRONTICK_HOME/);
    const changed = mkBackend({ inspection: registered({ env: { CRONTICK_SUPERVISED: '1', CRONTICK_HOME: '/a' } }) });
    const s2 = await svc({ backend: changed, deps: mkDeps({ env: { CRONTICK_HOME: '/b' } }) }).status();
    expect(s2.staleReasons.join()).toMatch(/CRONTICK_HOME/);
    const removed = await svc({ backend: changed }).status();
    expect(removed.staleReasons.join()).toMatch(/CRONTICK_HOME/);
  });
  it('does not compare env when backend reports none', async () => {
    const b = mkBackend({ inspection: registered({ env: {} }) });
    const s = await svc({ backend: b, deps: mkDeps({ env: { CRONTICK_HOME: '/data' } }) }).status();
    expect(s.stale).toBe(false);
  });
  it('uses backend.expectedCommand when provided', async () => {
    const exp = ['/opt/crontick/dist/cli/index.js', 'daemon', 'start'];
    const b = mkBackend({ expectedCommand: () => exp, inspection: registered({ args: exp }) });
    expect((await svc({ backend: b }).status()).stale).toBe(false);
    const b2 = mkBackend({ expectedCommand: () => exp, inspection: registered({ args: [SCRIPT] }) });
    expect((await svc({ backend: b2 }).status()).stale).toBe(true);
  });
  it('PATH difference adds a hint but is not stale', async () => {
    const s = await svc({ backend: mkBackend({ inspection: registered() }), deps: mkDeps({ env: { PATH: '/new:/usr/bin' } }) }).status();
    expect(s.stale).toBe(false);
    expect(s.hints.join()).toMatch(/PATH/);
  });
  it('registered but disabled in manager is not enabled', async () => {
    const insp = { ...registered(), enabledInManager: false };
    expect((await svc({ backend: mkBackend({ inspection: insp }) }).status()).enabled).toBe(false);
  });
  it('inspect failure does not throw', async () => {
    const b = mkBackend({ inspect: async () => { throw new Error('boom'); } });
    const s = await svc({ backend: b }).status();
    expect(s.reason).toMatch(/boom/);
  });
});

describe('AutostartService.enable', () => {
  it('installs the built spec after availability and script checks', async () => {
    const b = mkBackend();
    const r = await svc({ backend: b }).enable();
    expect(r).toMatchObject({ enabled: true, mechanism: 'systemd-user', definitionPath: '/home/u/.config/systemd/user/crontick.service' });
    expect(b.install).toHaveBeenCalledWith(expect.objectContaining({ nodePath: NODE, daemonScript: SCRIPT, cliScript: CLI }));
  });
  it('throws AUTOSTART_UNSUPPORTED on unsupported platform (status does not)', async () => {
    const s = svc({ backend: undefined, deps: mkDeps({ platform: 'freebsd' }) });
    await expect(s.enable()).rejects.toMatchObject({ code: 'AUTOSTART_UNSUPPORTED' });
    await expect(s.disable()).rejects.toMatchObject({ code: 'AUTOSTART_UNSUPPORTED' });
    await expect(s.status()).resolves.toMatchObject({ supported: false });
  });
  it('refuses when the daemon script is missing', async () => {
    const b = mkBackend();
    const s = svc({ backend: b, deps: mkDeps({}, [SCRIPT]) });
    await expect(s.enable()).rejects.toMatchObject({ code: 'AUTOSTART_SCRIPT_MISSING' });
    expect(b.install).not.toHaveBeenCalled();
  });
  it('refuses _npx paths', async () => {
    const b = mkBackend();
    const script = '/home/u/.npm/_npx/abc/node_modules/crontick/dist/daemon/index.js';
    await expect(svc({ backend: b, script }).enable()).rejects.toMatchObject({ code: 'AUTOSTART_EPHEMERAL_PATH' });
    expect(b.install).not.toHaveBeenCalled();
  });
  it('maps unavailable backend to AUTOSTART_UNAVAILABLE and does not install', async () => {
    const b = mkBackend({ available: async () => ({ ok: false, reason: 'no bus' }) });
    await expect(svc({ backend: b }).enable()).rejects.toMatchObject({ code: 'AUTOSTART_UNAVAILABLE' });
    expect(b.install).not.toHaveBeenCalled();
  });
  it('maps install failure to CrontickError AUTOSTART_FAILED', async () => {
    const b = mkBackend({ install: async () => { throw new Error('denied'); } });
    const err = await svc({ backend: b }).enable().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrontickError);
    expect((err as CrontickError).code).toBe('AUTOSTART_FAILED');
  });
});

describe('AutostartService.disable', () => {
  it('is idempotent: returns removed:false when nothing registered', async () => {
    const b = mkBackend({ uninstall: async () => ({ removed: false }) });
    await expect(svc({ backend: b }).disable()).resolves.toMatchObject({ removed: false });
  });
  it('returns removed:true when removed', async () => {
    await expect(svc().disable()).resolves.toMatchObject({ removed: true });
  });
  it('maps uninstall failure to AUTOSTART_FAILED', async () => {
    const b = mkBackend({ uninstall: async () => { throw new Error('x'); } });
    await expect(svc({ backend: b }).disable()).rejects.toMatchObject({ code: 'AUTOSTART_FAILED' });
  });
});
