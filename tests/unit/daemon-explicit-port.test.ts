/** Explicit `daemon.port` in config.json: a busy port fails `daemon start` loudly; a second start for the same data dir reuses the running daemon. */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import net from 'node:net';

const CLI = resolve('dist/cli/index.js');
let dir: string;
let blocker: net.Server;
let busyPort: number;
let env: NodeJS.ProcessEnv;

function cli(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', timeout: 30_000, env });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crontick-explicitport-'));
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
  busyPort = (blocker.address() as net.AddressInfo).port;
  env = { ...process.env, CRONTICK_HOME: dir };
});

afterAll(async () => {
  cli(['daemon', 'stop']);
  await new Promise<void>((r) => blocker.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('explicit daemon.port', () => {
  it('daemon start exits non-zero with DAEMON_PORT_IN_USE text when the port is busy', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ daemon: { port: busyPort } }));
    const r = cli(['daemon', 'start']);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`Port ${busyPort} (config daemon.port) is in use by another process`);
    expect(r.out).toContain('change daemon.port in');
  });

  it('a second start for the same data dir connects to the running daemon on the explicit port', async () => {
    const port = await freePort();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ daemon: { port } }));
    const first = cli(['daemon', 'start']);
    expect(first.status, first.out).toBe(0);
    expect(first.out).toContain(`127.0.0.1:${port}`);
    const second = cli(['daemon', 'start']);
    expect(second.status, second.out).toBe(0);
    expect(second.out).toContain(`127.0.0.1:${port}`);
  });

  it('status and info show a config-says note after daemon.port is edited while running', async () => {
    cli(['daemon', 'stop']);
    const port = await freePort();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ daemon: { port } }));
    expect(cli(['daemon', 'start']).status).toBe(0);
    const edited = await freePort();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ daemon: { port: edited } }));
    const note = `config says daemon.port ${edited}, running on ${port}`;
    const status = cli(['daemon', 'status']);
    expect(status.out).toContain(note);
    expect(cli(['info']).out).toContain(note);
  });
});
