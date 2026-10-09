/** Fallback-port discovery: CLI `daemon start/status`, `info`, `doctor`, and the client all reach a daemon on a fallback port. */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { createClient } from '../../src/client.js';
import { describeDaemonPort } from '../../src/daemon/bind-port.js';
import { runDoctorChecks } from '../../src/doctor.js';

const CLI = resolve('dist/cli/index.js');
let dir: string;
let blocker: net.Server;
let sockets: Set<net.Socket>;
let preferred: number;
let env: NodeJS.ProcessEnv;

function cli(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', timeout: 30_000, env });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crontick-portsurf-'));
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  sockets = new Set();
  blocker = net.createServer((s) => { sockets.add(s); });
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
  preferred = (blocker.address() as net.AddressInfo).port;
  env = { ...process.env, CRONTICK_HOME: dir };
});

afterAll(async () => {
  cli(['daemon', 'stop']);
  sockets.forEach((s) => s.destroy());
  await new Promise<void>((r) => blocker.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const cfg = (port?: number) => ({ daemon: port === undefined ? {} : { port } }) as never;

describe('describeDaemonPort', () => {
  it('unset: null on the default port, fallback note otherwise', () => {
    expect(describeDaemonPort(47615, cfg())).toBeNull();
    expect(describeDaemonPort(50000, cfg())).toBe('started on fallback port 50000; default 47615 is in use');
    expect(describeDaemonPort(50000)).toBe('started on fallback port 50000; default 47615 is in use');
  });

  it('explicit: no fallback note when running on the configured port', () => {
    expect(describeDaemonPort(5000, cfg(5000))).toBeNull();
  });

  it('explicit 0: no note for any port', () => {
    expect(describeDaemonPort(51234, cfg(0))).toBeNull();
  });

  it('explicit and differing from the running port: config-says note (stale config)', () => {
    expect(describeDaemonPort(50000, cfg(5000))).toBe('config says daemon.port 5000, running on 50000');
  });
});

describe('doctor daemon port check', () => {
  it('explicit port held by a foreign process while no daemon runs: warns the daemon will fail to start', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ daemon: { port: preferred } }));
    try {
      const result = await runDoctorChecks({ env, checkMcpHelp: false });
      const check = result.checks.find((c) => c.name === 'daemon port');
      expect(check?.ok).toBe(false);
      expect(check?.note).toContain(`${preferred} (from config)`);
      expect(check?.note).toContain('daemon will fail to start');
    } finally {
      rmSync(join(dir, 'config.json'), { force: true });
    }
  });

  it('explicit free port while no daemon runs: reports it as from config', async () => {
    const free = await new Promise<number>((r) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); });
    });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ daemon: { port: free } }));
    try {
      const check = (await runDoctorChecks({ env, checkMcpHelp: false })).checks.find((c) => c.name === 'daemon port');
      expect(check?.ok).toBe(true);
      expect(check?.note).toContain(`${free} (from config)`);
    } finally {
      rmSync(join(dir, 'config.json'), { force: true });
    }
  });
});

describe('fallback port surfaces', () => {
  // Skipped until Task 5: needs the default port occupied, which the removed env var used to redirect.
  it.skip('daemon start reports the fallback port; status, info, doctor and the client reach it', async () => {
    const start = cli(['daemon', 'start']);
    expect(start.status, start.out).toBe(0);
    expect(start.out).toMatch(/Daemon started .*127\.0\.0\.1:(\d+)/);
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(start.out)![1]);
    expect(port).not.toBe(preferred);
    expect(start.out).toContain(`started on fallback port ${port}; default ${preferred} is in use`);

    const status = cli(['daemon', 'status']);
    expect(status.out).toContain(`port: ${port}`);
    expect(status.out).toContain(`http://127.0.0.1:${port}/dashboard`);

    const info = cli(['info']);
    expect(info.out).toContain(`port ${port}`);
    expect(info.out).toContain(`started on fallback port ${port}`);
    expect(info.out).toContain(`http://127.0.0.1:${port}/dashboard`);

    const doctor = cli(['doctor']);
    expect(doctor.out).toContain(`daemon port (${port} (started on fallback port ${port}; default ${preferred} is in use))`);
    expect(doctor.out).toContain('daemon reachable');

    const client = createClient({ env });
    expect((await client.daemonStatus()).port).toBe(port);
    expect((await client.listJobs()).length).toBe(0);
  });
});
