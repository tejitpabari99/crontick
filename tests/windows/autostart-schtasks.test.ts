// Windows-only integration test (SP09 AC4): real schtasks.exe, unique task name via the
// SchtasksBackend `taskName` seam so it never collides with a real `\crontick\daemon` install.
// Requires a prior `npm run build` (dist/cli, dist/daemon). Skipped off win32.
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchtasksBackend } from '../../src/autostart/schtasks.js';
import { AutostartService } from '../../src/autostart/service.js';
import type { AutostartDeps } from '../../src/autostart/types.js';

const isWin = process.platform === 'win32';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

function schtasks(args: string[]): { status: number | null; out: string } {
  const r = spawnSync('schtasks', args, { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe.skipIf(!isWin)('windows autostart (real schtasks)', () => {
  const cli = resolve('dist', 'cli', 'index.js');
  const daemon = resolve('dist', 'daemon', 'index.js');
  const taskName = `\\crontick-test\\daemon-${Math.random().toString(36).slice(2, 10)}`;
  let home = '';
  let deps: AutostartDeps;
  let service: AutostartService;

  beforeAll(() => {
    expect(existsSync(cli)).toBe(true);
    expect(existsSync(daemon)).toBe(true);
    home = mkdtempSync(join(tmpdir(), 'crontick-autostart-'));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ daemon: { port: 0 } }));
    deps = {
      platform: 'win32',
      env: { ...process.env, CRONTICK_HOME: home },
      homedir: homedir(),
      exec: (file, args) => new Promise((done) => {
        execFile(file, args, { encoding: 'utf-8', timeout: 30_000 }, (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0;
          done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
      }),
      fs: {
        readFile: (p, enc) => readFile(p, enc),
        writeFile: (p, d, o) => writeFile(p, d, o),
        mkdir: (p, o) => mkdir(p, o),
        rm: (p, o) => rm(p, o),
        access: (p) => access(p),
      },
    };
    service = new AutostartService({
      deps,
      backend: new SchtasksBackend(deps, taskName),
      nodePath: process.execPath,
      daemonScript: daemon,
      cliScript: cli,
    });
  });

  afterAll(() => {
    try {
      spawnSync(process.execPath, [cli, 'daemon', 'stop'], { env: { ...process.env, CRONTICK_HOME: home }, encoding: 'utf8' });
      const pidFile = join(home, 'daemon.pid');
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8').trim().split(/\s+/)[0]);
        if (pid && alive(pid)) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      }
    } catch { /* best effort */ }
    schtasks(['/Delete', '/TN', taskName, '/F']);
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('enable -> query -> status -> re-enable -> run (launcher survival) -> disable -> absent', async () => {
    const en = await service.enable();
    expect(en.enabled).toBe(true);
    expect(en.mechanism).toBe('schtasks');
    expect(en.definitionPath).toBe(taskName);

    // Independent of our backend: the task really exists.
    expect(schtasks(['/Query', '/TN', taskName]).status).toBe(0);

    const st = await service.status();
    expect(st.supported).toBe(true);
    expect(st.enabled).toBe(true);
    expect(st.stale).toBe(false);
    expect(st.staleReasons).toEqual([]);

    // Idempotent re-enable.
    expect((await service.enable()).enabled).toBe(true);
    const st2 = await service.status();
    expect(st2.enabled).toBe(true);
    expect(st2.stale).toBe(false);

    // Launcher survival: daemon started by the task outlives the launcher instance.
    expect(schtasks(['/Run', '/TN', taskName]).status).toBe(0);
    const pidFile = join(home, 'daemon.pid');
    const portFile = join(home, 'daemon.port');
    const deadline = Date.now() + 90_000;
    let launcherDone = false;
    while (Date.now() < deadline) {
      await sleep(1000);
      const s = await service.status();
      if (existsSync(pidFile) && existsSync(portFile) && s.active === false) { launcherDone = true; break; }
    }
    expect(launcherDone).toBe(true);
    await sleep(10_000);
    const pid = Number(readFileSync(pidFile, 'utf8').trim().split(/\s+/)[0]);
    const port = Number(readFileSync(portFile, 'utf8').trim());
    expect(alive(pid)).toBe(true);
    const res = await fetch(`http://127.0.0.1:${String(port)}/health`);
    expect(res.status).toBe(200);

    const dis = await service.disable();
    expect(dis.removed).toBe(true);
    expect(schtasks(['/Query', '/TN', taskName]).status).not.toBe(0);
    const st3 = await service.status();
    expect(st3.enabled).toBe(false);
    expect((await service.disable()).removed).toBe(false);
  }, 240_000);
});
