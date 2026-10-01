import { describe, it, expect, vi } from 'vitest';
import { bindPort, formatPortFallbackMessage, preferredDaemonPort, type BindPortDeps } from '../../src/daemon/bind-port.js';
import { DEFAULT_DAEMON_PORT } from '../../src/constants/daemon.js';

function inUse(): Error {
  return Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
}

function deps(over: Partial<BindPortDeps> & { taken?: boolean } = {}): BindPortDeps & { notify: ReturnType<typeof vi.fn>; listen: ReturnType<typeof vi.fn> } {
  const listen = vi.fn(async (port: number) => {
    if (port !== 0 && over.taken) throw inUse();
    return port === 0 ? 51234 : port;
  });
  return {
    listen,
    probe: over.probe ?? (async () => ({ kind: 'foreign' as const })),
    notify: vi.fn(),
  } as never;
}

describe('daemon port binding', () => {
  it('defaults to 47615', () => {
    expect(DEFAULT_DAEMON_PORT).toBe(47615);
    expect(preferredDaemonPort({})).toBe(47615);
  });

  it('honors CRONTICK_DAEMON_PORT and ignores invalid values', () => {
    expect(preferredDaemonPort({ CRONTICK_DAEMON_PORT: '0' })).toBe(0);
    expect(preferredDaemonPort({ CRONTICK_DAEMON_PORT: '5000' })).toBe(5000);
    expect(preferredDaemonPort({ CRONTICK_DAEMON_PORT: 'abc' })).toBe(47615);
    expect(preferredDaemonPort({ CRONTICK_DAEMON_PORT: '70000' })).toBe(47615);
  });

  it('binds the preferred port when free, without notice', async () => {
    const d = deps();
    const r = await bindPort(47615, d);
    expect(r).toEqual({ port: 47615, preferred: 47615, fellBack: false });
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('falls back with the foreign-process message when a non-crontick process holds the port', async () => {
    const d = deps({ taken: true });
    const r = await bindPort(47615, d);
    expect(r.fellBack).toBe(true);
    expect(r.port).toBe(51234);
    expect(d.notify).toHaveBeenCalledWith('Port 47615 is in use by another process (not crontick); starting on a free port');
  });

  it('names the other crontick daemon (pid, data dir) when the occupant answers /health', async () => {
    const d = deps({ taken: true, probe: async () => ({ kind: 'crontick', pid: 4242, dataDir: '/tmp/other' }) });
    const r = await bindPort(47615, d);
    expect(r.message).toBe('Port 47615 is in use by another crontick daemon (pid 4242, data dir /tmp/other); starting on a free port');
    expect(formatPortFallbackMessage(1, { kind: 'crontick' })).toContain('pid unknown');
  });

  it('treats a failing probe as a foreign process', async () => {
    const d = deps({ taken: true, probe: async () => { throw new Error('boom'); } });
    expect((await bindPort(47615, d)).occupant).toEqual({ kind: 'foreign' });
  });

  it('rethrows non-EADDRINUSE listen errors and never falls back for port 0', async () => {
    const eacces = Object.assign(new Error('nope'), { code: 'EACCES' });
    await expect(bindPort(80, { listen: async () => { throw eacces; }, probe: async () => ({ kind: 'foreign' }), notify: vi.fn() })).rejects.toBe(eacces);
    await expect(bindPort(0, { listen: async () => { throw inUse(); }, probe: async () => ({ kind: 'foreign' }), notify: vi.fn() })).rejects.toThrow('EADDRINUSE');
  });
});
