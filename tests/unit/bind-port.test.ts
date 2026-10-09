import { describe, it, expect, vi } from 'vitest';
import { bindPort, formatPortFallbackMessage, preferredDaemonPort, type BindPortDeps } from '../../src/daemon/bind-port.js';
import { CrontickError } from '../../src/errors.js';
import { DEFAULT_DAEMON_PORT } from '../../src/constants/daemon.js';

function inUse(): Error {
  return Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
}

const CFG = '/home/x/.crontick/config.json';
const UNSET = { port: 47615, explicit: false } as const;

function deps(over: Partial<BindPortDeps> & { taken?: boolean } = {}): BindPortDeps & { notify: ReturnType<typeof vi.fn>; listen: ReturnType<typeof vi.fn> } {
  const listen = vi.fn(async (port: number) => {
    if (port !== 0 && over.taken) throw inUse();
    return port === 0 ? 51234 : port;
  });
  return {
    listen,
    probe: over.probe ?? (async () => ({ kind: 'foreign' as const })),
    notify: vi.fn(),
    configPath: CFG,
    dataDir: over.dataDir ?? '/data/mine',
  } as never;
}

const cfg = (port?: number) => ({ daemon: port === undefined ? {} : { port } }) as never;

describe('daemon port binding', () => {
  it('defaults to 47615, not explicit, when daemon.port is unset', () => {
    expect(DEFAULT_DAEMON_PORT).toBe(47615);
    expect(preferredDaemonPort(cfg())).toEqual({ port: 47615, explicit: false });
  });

  it('returns the configured port as explicit (including 0) and ignores the env var', () => {
    expect(preferredDaemonPort(cfg(5000))).toEqual({ port: 5000, explicit: true });
    expect(preferredDaemonPort(cfg(0))).toEqual({ port: 0, explicit: true });
    process.env['CRONTICK_DAEMON_PORT'] = '1234';
    try {
      expect(preferredDaemonPort(cfg())).toEqual({ port: 47615, explicit: false });
    } finally {
      delete process.env['CRONTICK_DAEMON_PORT'];
    }
  });

  it('unset: binds the default port when free, without notice', async () => {
    const d = deps();
    const r = await bindPort(UNSET, d);
    expect(r).toEqual({ port: 47615, preferred: 47615, fellBack: false });
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('unset: falls back with the foreign-process message when a non-crontick process holds the port', async () => {
    const d = deps({ taken: true });
    const r = await bindPort(UNSET, d);
    expect(r.fellBack).toBe(true);
    expect(r.port).toBe(51234);
    expect(d.notify).toHaveBeenCalledWith('Port 47615 is in use by another process (not crontick); starting on a free port');
  });

  it('unset: names the other crontick daemon (pid, data dir) when the occupant answers /health', async () => {
    const d = deps({ taken: true, probe: async () => ({ kind: 'crontick', pid: 4242, dataDir: '/tmp/other' }) });
    const r = await bindPort(UNSET, d);
    expect(r.message).toBe('Port 47615 is in use by another crontick daemon (pid 4242, data dir /tmp/other); starting on a free port');
    expect(formatPortFallbackMessage(1, { kind: 'crontick' })).toContain('pid unknown');
  });

  it('unset: treats a failing probe as a foreign process', async () => {
    const d = deps({ taken: true, probe: async () => { throw new Error('boom'); } });
    expect((await bindPort(UNSET, d)).occupant).toEqual({ kind: 'foreign' });
  });

  it('explicit busy by a foreign process throws DAEMON_PORT_IN_USE with no fallback', async () => {
    const d = deps({ taken: true });
    const err = await bindPort({ port: 5000, explicit: true }, d).catch((e) => e);
    expect(err).toBeInstanceOf(CrontickError);
    expect(err.code).toBe('DAEMON_PORT_IN_USE');
    expect(err.message).toBe(`Port 5000 (config daemon.port) is in use by another process (not crontick); free it or change daemon.port in ${CFG}`);
    expect(err.details).toEqual({ port: 5000, occupant: { kind: 'foreign' }, configPath: CFG });
    expect(d.notify).not.toHaveBeenCalled();
    expect(d.listen).toHaveBeenCalledTimes(1);
  });

  it('explicit busy by a crontick daemon of another data dir names pid and data dir', async () => {
    const occupant = { kind: 'crontick' as const, pid: 77, dataDir: '/data/other' };
    const d = deps({ taken: true, probe: async () => occupant });
    const err = await bindPort({ port: 5000, explicit: true }, d).catch((e) => e);
    expect(err.code).toBe('DAEMON_PORT_IN_USE');
    expect(err.message).toBe(`Port 5000 (config daemon.port) is in use by another crontick daemon (pid 77, data dir /data/other); free it or change daemon.port in ${CFG}`);
    expect(err.details).toEqual({ port: 5000, occupant, configPath: CFG });
    expect(d.listen).toHaveBeenCalledTimes(1);
  });

  it('explicit busy by a crontick daemon of the same data dir suggests daemon stop', async () => {
    const occupant = { kind: 'crontick' as const, pid: 88, dataDir: '/data/mine' };
    const d = deps({ taken: true, probe: async () => occupant, dataDir: '/data/mine' });
    const err = await bindPort({ port: 5000, explicit: true }, d).catch((e) => e);
    expect(err.code).toBe('DAEMON_PORT_IN_USE');
    expect(err.message).toBe('Port 5000 (config daemon.port) is held by a crontick daemon for this data dir (pid 88); run `crontick daemon stop`');
    expect(err.details).toEqual({ port: 5000, occupant, configPath: CFG });
  });

  it('explicit busy with a failing probe is reported as not crontick', async () => {
    const d = deps({ taken: true, probe: async () => { throw new Error('boom'); } });
    const err = await bindPort({ port: 5000, explicit: true }, d).catch((e) => e);
    expect(err.details.occupant).toEqual({ kind: 'foreign' });
  });

  it('explicit 0 binds an OS-assigned port silently', async () => {
    const d = deps();
    const r = await bindPort({ port: 0, explicit: true }, d);
    expect(r).toEqual({ port: 51234, preferred: 0, fellBack: false });
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('rethrows EACCES, naming the port and config key when explicit', async () => {
    const eacces = Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
    const base = { probe: async () => ({ kind: 'foreign' as const }), notify: vi.fn(), configPath: CFG, dataDir: '/d', listen: async () => { throw eacces; } };
    await expect(bindPort({ port: 80, explicit: true }, base)).rejects.toBe(eacces);
    expect(eacces.message).toContain('80');
    expect(eacces.message).toContain('daemon.port');
    const plain = Object.assign(new Error('nope'), { code: 'EACCES' });
    await expect(bindPort(UNSET, { ...base, listen: async () => { throw plain; } })).rejects.toBe(plain);
  });

  it('never falls back for unset-resolved port 0 EADDRINUSE', async () => {
    await expect(bindPort({ port: 0, explicit: true }, { listen: async () => { throw inUse(); }, probe: async () => ({ kind: 'foreign' }), notify: vi.fn(), configPath: CFG, dataDir: '/d' })).rejects.toThrow('EADDRINUSE');
  });
});
