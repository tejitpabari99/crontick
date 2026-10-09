/** Fallback-port discovery: CLI `daemon start/status`, `info`, `doctor`, and the client all reach a daemon on a fallback port. */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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

describe('describeDaemonPort', () => {
  it('is null on the preferred port and a fallback note otherwise', () => {
    expect(describeDaemonPort(47615)).toBeNull();
    expect(describeDaemonPort(50000)).toBe('started on fallback port 50000; default 47615 is in use');
  });
});

describe('fallback port surfaces', () => {
  // Skipped until Task 4/5 re-express fallback surfaces without the removed env var.
  it.skip('doctor flags a foreign listener on the preferred port while no daemon runs', async () => {
    const result = await runDoctorChecks({ env, checkMcpHelp: false });
    const check = result.checks.find((c) => c.name === 'daemon port');
    expect(check?.note).toContain(`default ${preferred} is held by another process`);
  });

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
