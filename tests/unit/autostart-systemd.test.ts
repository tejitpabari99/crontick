import { describe, expect, it } from 'vitest';
import { createAutostartBackend } from '../../src/autostart/index.js';
import { renderUnit, parseUnit } from '../../src/autostart/unit.js';
import { SystemdBackend } from '../../src/autostart/systemd.js';
import type { AutostartDeps, AutostartSpec } from '../../src/autostart/types.js';

const spec: AutostartSpec = {
  nodePath: '/usr/bin/node',
  daemonScript: '/opt/crontick/dist/daemon/index.js',
  cliScript: '/opt/crontick/dist/cli/index.js',
  env: { CRONTICK_SUPERVISED: '1', CRONTICK_HOME: '/data/ct', PATH: '/usr/bin:/bin' },
};
const UNIT = '/home/u/.config/systemd/user/crontick.service';

interface Harness {
  deps: AutostartDeps;
  calls: string[][];
  files: Map<string, string>;
  respond: Record<string, { code: number; stdout?: string; stderr?: string }>;
}

function harness(opts: { env?: NodeJS.ProcessEnv; files?: Record<string, string> } = {}): Harness {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const calls: string[][] = [];
  const respond: Harness['respond'] = {};
  const deps: AutostartDeps = {
    platform: 'linux',
    env: opts.env ?? {},
    homedir: '/home/u',
    exec: async (file, args) => {
      calls.push([file, ...args]);
      const r = respond[args.join(' ')] ?? { code: 0 };
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    fs: {
      readFile: async (p) => {
        const v = files.get(p);
        if (v === undefined) throw new Error('ENOENT');
        return v;
      },
      writeFile: async (p, d) => void files.set(p, String(d)),
      mkdir: async () => undefined,
      rm: async (p) => void files.delete(p),
      access: async (p) => {
        if (!files.has(p)) throw new Error('ENOENT');
      },
    },
  };
  return { deps, calls, files, respond };
}

describe('unit renderer/parser', () => {
  it('renders the documented unit', () => {
    const u = renderUnit(spec);
    expect(u).toContain('ExecStart="/usr/bin/node" "/opt/crontick/dist/daemon/index.js"');
    expect(u).toContain('Environment="CRONTICK_SUPERVISED=1"');
    expect(u).toContain('Environment="CRONTICK_HOME=/data/ct"');
    expect(u).toContain('Environment="PATH=/usr/bin:/bin"');
    for (const l of ['Type=simple', 'Restart=on-failure', 'RestartSec=5', 'KillMode=process', 'WantedBy=default.target']) {
      expect(u).toContain(l);
    }
    expect(u).not.toContain('SuccessExitStatus');
  });

  it('omits CRONTICK_HOME when unset', () => {
    expect(renderUnit({ ...spec, env: { CRONTICK_SUPERVISED: '1' } })).not.toContain('CRONTICK_HOME');
  });

  it('escapes %, $, quotes, backslashes and spaces; round-trips', () => {
    const s: AutostartSpec = {
      ...spec,
      nodePath: '/opt/my node/bin/node',
      daemonScript: '/opt/50%/a"b\\c/$x/index.js',
      env: { CRONTICK_SUPERVISED: '1', PATH: '/a b:/c%d:/e$f:/g"h' },
    };
    const u = renderUnit(s);
    expect(u).toContain('50%%');
    expect(u).toContain('$$x'); // ExecStart: doubled
    expect(u).toContain('/e$f:'); // Environment=: systemd does not expand $, so it stays single
    expect(u).not.toContain('$$f');
    const parsed = parseUnit(u);
    expect(parsed).toEqual({ nodePath: s.nodePath, args: [s.daemonScript], env: s.env });
  });

  it('round-trips the plain spec', () => {
    expect(parseUnit(renderUnit(spec))).toEqual({ nodePath: spec.nodePath, args: [spec.daemonScript], env: spec.env });
  });

  it('parseUnit returns undefined without ExecStart', () => {
    expect(parseUnit('[Service]\nType=simple\n')).toBeUndefined();
  });
});

describe('SystemdBackend', () => {
  it('is registered for linux only', () => {
    expect(createAutostartBackend(harness().deps)?.mechanism).toBe('systemd-user');
    expect(createAutostartBackend({ ...harness().deps, platform: 'freebsd' })).toBeUndefined();
  });

  it('available: ok when show-environment succeeds', async () => {
    const h = harness();
    expect(await new SystemdBackend(h.deps).available()).toEqual({ ok: true });
    expect(h.calls[0]).toEqual(['systemctl', '--user', 'show-environment']);
  });

  it('available: not ok on non-zero exit and on exec throw', async () => {
    const h = harness();
    h.respond['--user show-environment'] = { code: 1, stderr: 'Failed to connect to bus' };
    const r = await new SystemdBackend(h.deps).available();
    expect(r.ok).toBe(false);
    const h2 = harness();
    h2.deps.exec = async () => {
      throw new Error('spawn systemctl ENOENT');
    };
    const r2 = await new SystemdBackend(h2.deps).available();
    expect(r2).toMatchObject({ ok: false });
    expect(h2.files.size).toBe(0);
  });

  it('uses XDG_CONFIG_HOME when set', async () => {
    const h = harness({ env: { XDG_CONFIG_HOME: '/xdg' } });
    const { definitionPath } = await new SystemdBackend(h.deps).install(spec);
    expect(definitionPath).toBe('/xdg/systemd/user/crontick.service');
  });

  it('install writes, reloads, enables --now; idempotent without restart when inactive', async () => {
    const h = harness();
    const b = new SystemdBackend(h.deps);
    const r = await b.install(spec);
    expect(r.definitionPath).toBe(UNIT);
    expect(h.files.get(UNIT)).toBe(renderUnit(spec));
    expect(h.calls.map((c) => c.slice(2).join(' '))).toEqual(['is-active crontick.service', 'daemon-reload', 'enable --now crontick.service']);
    h.calls.length = 0;
    await b.install(spec);
    expect(h.calls.some((c) => c.includes('restart'))).toBe(false);
  });

  it('install restarts when content changed and unit is active', async () => {
    const h = harness({ files: { [UNIT]: 'old' } });
    h.respond['--user is-active crontick.service'] = { code: 0, stdout: 'active\n' };
    await new SystemdBackend(h.deps).install(spec);
    expect(h.calls.at(-1)).toEqual(['systemctl', '--user', 'restart', 'crontick.service']);
  });

  it('install does not restart when unchanged and active', async () => {
    const h = harness({ files: { [UNIT]: renderUnit(spec) } });
    h.respond['--user is-active crontick.service'] = { code: 0, stdout: 'active\n' };
    await new SystemdBackend(h.deps).install(spec);
    expect(h.calls.some((c) => c.includes('restart'))).toBe(false);
  });

  it('install throws with stderr when enable fails', async () => {
    const h = harness();
    h.respond['--user enable --now crontick.service'] = { code: 1, stderr: 'boom' };
    await expect(new SystemdBackend(h.deps).install(spec)).rejects.toThrow(/boom/);
  });

  it('uninstall disables, removes, reloads; second call is a no-op', async () => {
    const h = harness({ files: { [UNIT]: renderUnit(spec) } });
    const b = new SystemdBackend(h.deps);
    expect(await b.uninstall()).toEqual({ removed: true });
    expect(h.files.has(UNIT)).toBe(false);
    expect(h.calls.map((c) => c.slice(2).join(' '))).toEqual(['disable --now crontick.service', 'daemon-reload']);
    h.calls.length = 0;
    expect(await b.uninstall()).toEqual({ removed: false });
    expect(h.calls).toEqual([]);
  });

  it('inspect: not registered is a value', async () => {
    const h = harness();
    expect(await new SystemdBackend(h.deps).inspect()).toEqual({ registered: false });
  });

  it('inspect: parses unit, enabled/active, linger hint', async () => {
    const h = harness({ files: { [UNIT]: renderUnit(spec) } });
    h.respond['--user is-enabled crontick.service'] = { code: 0, stdout: 'enabled\n' };
    h.respond['--user is-active crontick.service'] = { code: 0, stdout: 'active\n' };
    h.respond['show-user -p Linger'] = { code: 0, stdout: 'Linger=no\n' };
    const i = await new SystemdBackend(h.deps).inspect();
    expect(i).toMatchObject({
      registered: true,
      enabledInManager: true,
      active: true,
      definitionPath: UNIT,
      command: { nodePath: spec.nodePath, args: [spec.daemonScript], env: spec.env },
    });
    expect(i.notes?.join(' ')).toContain('loginctl enable-linger');
  });

  it('inspect: disabled/inactive, no linger hint when linger=yes or loginctl fails', async () => {
    const h = harness({ files: { [UNIT]: renderUnit(spec) } });
    h.respond['--user is-enabled crontick.service'] = { code: 1, stdout: 'disabled\n' };
    h.respond['--user is-active crontick.service'] = { code: 3, stdout: 'inactive\n' };
    h.respond['show-user -p Linger'] = { code: 0, stdout: 'Linger=yes\n' };
    const i = await new SystemdBackend(h.deps).inspect();
    expect(i.enabledInManager).toBe(false);
    expect(i.active).toBe(false);
    expect(i.notes ?? []).toEqual([]);
    h.respond['show-user -p Linger'] = { code: 1 };
    expect((await new SystemdBackend(h.deps).inspect()).notes ?? []).toEqual([]);
  });
});
