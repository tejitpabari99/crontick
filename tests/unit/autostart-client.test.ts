import { describe, expect, it } from 'vitest';
import { CrontickClient } from '../../src/client.js';
import { CrontickError } from '../../src/errors.js';
import type { AutostartDeps } from '../../src/autostart/types.js';

function fakeDeps(platform: NodeJS.Platform, files: Map<string, string>, calls: string[][]): AutostartDeps {
  return {
    platform,
    env: { PATH: '/usr/bin', CRONTICK_HOME: '/tmp/home' },
    homedir: '/home/u',
    async exec(file, args) {
      calls.push([file, ...args]);
      if (args.includes('is-enabled')) return { code: 0, stdout: 'enabled\n', stderr: '' };
      if (args.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    fs: {
      async readFile(p) { const v = files.get(p); if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return v; },
      async writeFile(p, d) { files.set(p, String(d)); },
      async mkdir() { return undefined; },
      async rm(p) { files.delete(p); },
      async access(p) { if (!files.has(p) && !p.endsWith('index.js')) throw new Error('ENOENT'); },
    },
  };
}

describe('CrontickClient autostart', () => {
  it('enable, status, disable go through the injected deps with no daemon', async () => {
    const files = new Map<string, string>();
    const calls: string[][] = [];
    const c = new CrontickClient({ startDaemon: false, autostartDeps: fakeDeps('linux', files, calls) });
    const enabled = await c.autostartEnable();
    expect(enabled.enabled).toBe(true);
    expect(enabled.mechanism).toBe('systemd-user');
    expect([...files.keys()].some((k) => k.endsWith('crontick.service'))).toBe(true);
    expect(calls.some((x) => x.includes('daemon-reload'))).toBe(true);

    const status = await c.autostartStatus();
    expect(status.supported).toBe(true);
    expect(status.enabled).toBe(true);

    const removed = await c.autostartDisable();
    expect(removed.removed).toBe(true);
    expect([...files.keys()].some((k) => k.endsWith('crontick.service'))).toBe(false);
  });

  it('unsupported platform: status reports supported:false, enable throws AUTOSTART_UNSUPPORTED', async () => {
    const c = new CrontickClient({ startDaemon: false, autostartDeps: fakeDeps('freebsd', new Map(), []) });
    expect((await c.autostartStatus()).supported).toBe(false);
    await expect(c.autostartEnable()).rejects.toMatchObject({ code: 'AUTOSTART_UNSUPPORTED' });
    await expect(c.autostartEnable()).rejects.toBeInstanceOf(CrontickError);
  });
});
