import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAutostartBackend } from '../../src/autostart/index.js';
import { LaunchdBackend } from '../../src/autostart/launchd.js';
import { PLIST_LABEL, plistPaths, renderPlist } from '../../src/autostart/plist.js';
import type { AutostartDeps, AutostartSpec } from '../../src/autostart/types.js';

const spec: AutostartSpec = {
  nodePath: '/usr/local/bin/node',
  daemonScript: '/opt/crontick/dist/daemon/index.js',
  cliScript: '/opt/crontick/dist/cli/index.js',
  env: { CRONTICK_SUPERVISED: '1', CRONTICK_HOME: '/data/ct', PATH: '/usr/bin:/bin' },
};

function mkDeps(platform: NodeJS.Platform): AutostartDeps {
  return {
    platform,
    env: {},
    homedir: '/Users/u',
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    fs: {} as AutostartDeps['fs'],
  };
}

describe('createAutostartBackend darwin', () => {
  it('returns the launchd backend for darwin', () => {
    const b = createAutostartBackend(mkDeps('darwin'));
    expect(b).toBeInstanceOf(LaunchdBackend);
    expect(b?.mechanism).toBe('launchd');
  });

  it('still returns undefined for unsupported platforms', () => {
    expect(createAutostartBackend(mkDeps('freebsd'))).toBeUndefined();
  });

  it.skipIf(process.platform !== 'darwin')('rendered plist passes plutil -lint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crontick-plist-'));
    try {
      const f = join(dir, 'x.plist');
      writeFileSync(f, renderPlist(spec, PLIST_LABEL, plistPaths(spec)));
      expect(() => execFileSync('plutil', ['-lint', f])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
