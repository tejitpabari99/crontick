/**
 * Regression: test daemons/children and crontick-* temp dirs must never survive
 * cleanup, while processes outside the target dirs are left alone.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { cleanTargets, findLeakedPids } from '../../scripts/clean-test-lib.mjs';

const procs: ChildProcess[] = [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const idle = (home: string) =>
  spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    env: { ...process.env, CRONTICK_HOME: home },
    stdio: 'ignore',
  });

afterEach(() => {
  for (const p of procs.splice(0)) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
});

describe.skipIf(process.platform === 'win32')('clean-test', () => {
  // Discovery by CRONTICK_HOME/cwd/argv scans /proc, so it only exists on Linux.
  it.skipIf(process.platform !== 'linux')('kills processes tied to the target dir and removes it, leaving outsiders untouched', async () => {
    const target = mkdtempSync(join(tmpdir(), 'crontick-cleanup-target-'));
    const outside = mkdtempSync(join(tmpdir(), 'cleanup-outsider-'));
    mkdirSync(join(target, 'jobs'));
    const leaked = idle(target);
    const bystander = idle(outside);
    procs.push(leaked, bystander);
    await new Promise((r) => setTimeout(r, 300));

    expect(findLeakedPids([target])).toEqual([leaked.pid]);
    const result = await cleanTargets([target]);

    expect(result).toEqual({ pids: [], dirs: [] });
    expect(alive(leaked.pid!)).toBe(false);
    expect(existsSync(target)).toBe(false);
    expect(alive(bystander.pid!)).toBe(true);
  });

  it('kills a daemon identified only by its daemon.pid file', async () => {
    const target = mkdtempSync(join(tmpdir(), 'crontick-cleanup-pidfile-'));
    const p = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'daemon'], { stdio: 'ignore' });
    procs.push(p);
    writeFileSync(join(target, 'daemon.pid'), String(p.pid));
    await new Promise((r) => setTimeout(r, 300));
    const result = await cleanTargets([target]);
    expect(result).toEqual({ pids: [], dirs: [] });
    expect(alive(p.pid!)).toBe(false);
  });

  it('does not select a pid-file pid whose command line is not a crontick daemon (pid reuse)', async () => {
    const target = mkdtempSync(join(tmpdir(), 'crontick-cleanup-reused-'));
    const p = idle(join(tmpdir(), 'cleanup-elsewhere'));
    procs.push(p);
    writeFileSync(join(target, 'daemon.pid'), String(p.pid));
    await new Promise((r) => setTimeout(r, 300));
    expect(findLeakedPids([target], { commandLine: () => 'node /usr/bin/some-unrelated-tool' })).toEqual([]);
    const result = await cleanTargets([target]);
    expect(result).toEqual({ pids: [], dirs: [] });
    expect(alive(p.pid!)).toBe(true);
  });

  it('fails safe: skips a pid-file pid when process identity cannot be established', async () => {
    const target = mkdtempSync(join(tmpdir(), 'crontick-cleanup-unknown-'));
    const p = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'daemon'], { stdio: 'ignore' });
    procs.push(p);
    writeFileSync(join(target, 'daemon.pid'), String(p.pid));
    await new Promise((r) => setTimeout(r, 300));
    expect(findLeakedPids([target], { commandLine: () => undefined })).toEqual([]);
    expect(findLeakedPids([target], { commandLine: () => 'node crontick-daemon' })).toEqual([p.pid]);
  });
});
