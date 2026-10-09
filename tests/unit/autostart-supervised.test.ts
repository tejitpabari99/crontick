/** Supervised already-running exit code, SIGTERM exit code, and `daemon start --home`. */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { writeTestConfig } from '../helpers/test-home.js';

const DAEMON = resolve('dist/daemon/index.js');
const CLI = resolve('dist/cli/index.js');
const homes: string[] = [];
const procs: ChildProcess[] = [];

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crontick-supervised-'));
  homes.push(dir);
  writeTestConfig(dir);
  return dir;
}

function baseEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CRONTICK_HOME: home };
  delete env['CRONTICK_SUPERVISED'];
  return { ...env, ...extra };
}

async function waitFor(cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for condition');
}

function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((r) => child.once('exit', (code) => r(code)));
}

async function startDaemon(home: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [DAEMON], { env: baseEnv(home), stdio: 'ignore' });
  procs.push(child);
  await waitFor(() => existsSync(join(home, 'daemon.port')) && existsSync(join(home, 'daemon.pid')));
  return child;
}

async function secondStart(home: string, extra: NodeJS.ProcessEnv): Promise<number | null> {
  const child = spawn(process.execPath, [DAEMON], { env: baseEnv(home, extra), stdio: 'ignore' });
  procs.push(child);
  return exitOf(child);
}

afterEach(async () => {
  for (const p of procs.splice(0)) {
    if (p.exitCode === null && p.signalCode === null) {
      const done = exitOf(p);
      p.kill('SIGTERM');
      await done;
    }
  }
  for (const h of homes) {
    spawnSync(process.execPath, [CLI, 'daemon', 'stop'], { env: baseEnv(h), timeout: 20_000 });
  }
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('supervised already-running exit code', () => {
  it('exits 0 when CRONTICK_SUPERVISED=1 and a daemon already runs', async () => {
    const home = makeHome();
    await startDaemon(home);
    expect(await secondStart(home, { CRONTICK_SUPERVISED: '1' })).toBe(0);
  });

  it('exits non-zero when not supervised and a daemon already runs', async () => {
    const home = makeHome();
    await startDaemon(home);
    expect(await secondStart(home, {})).not.toBe(0);
  });
});

describe('graceful stop exit code', () => {
  it('daemon exits 0 on SIGTERM (so Restart=on-failure does not restart it)', async () => {
    const home = makeHome();
    const d = await startDaemon(home);
    const done = exitOf(d);
    d.kill('SIGTERM');
    expect(await done).toBe(0);
  });
});

describe('daemon start --home', () => {
  it('sets CRONTICK_HOME for the spawned daemon', async () => {
    const home = makeHome();
    const other = makeHome();
    const env = baseEnv(other);
    try {
      const r = spawnSync(process.execPath, [CLI, 'daemon', 'start', '--home', home], { env, encoding: 'utf-8', timeout: 30_000 });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      expect(existsSync(join(home, 'daemon.pid'))).toBe(true);
      expect(existsSync(join(other, 'daemon.pid'))).toBe(false);
    } finally {
      spawnSync(process.execPath, [CLI, 'daemon', 'stop'], { env: baseEnv(home), timeout: 20_000 });
    }
  });
});
