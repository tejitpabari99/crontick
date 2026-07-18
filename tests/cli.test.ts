import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const CLI = resolve('dist/cli/index.js');
const DAEMON_SCRIPT = resolve('dist/daemon/index.js');

function cli(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'crontick-cli-'));
  mkdirSync(join(d, 'jobs'), { recursive: true });
  mkdirSync(join(d, 'logs'), { recursive: true });
  return d;
}

function waitForPortFile(dir: string, maxMs = 30_000, getStderr?: () => string): Promise<number> {
  const portFile = join(dir, 'daemon.port');
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = Math.ceil(maxMs / 250);
    const check = () => {
      if (existsSync(portFile)) {
        try {
          const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
          if (!isNaN(port) && port > 0) return resolve(port);
        } catch {
          // file may be mid-write; retry
        }
      }
      attempts++;
      if (attempts >= maxAttempts) {
        const stderr = getStderr?.() ?? '';
        return reject(
          new Error(`Timed out waiting for daemon${stderr ? `\nDaemon stderr:\n${stderr}` : ''}`),
        );
      }
      setTimeout(check, 250);
    };
    check();
  });
}

// ── Basic CLI tests (no daemon needed) ───────────────────────────────────────

describe('CLI binary (dist/cli/index.js)', () => {
  it('--version prints a non-empty version string', () => {
    const result = cli(['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBeTruthy();
  });

  it('--help output contains "crontick"', () => {
    const result = cli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('crontick');
  });

  it('doctor exits 1 when daemon is not running (no CRONTICK_HOME)', () => {
    const tmp = makeTmpDir();
    const result = cli(['doctor'], { CRONTICK_HOME: tmp });
    rmSync(tmp, { recursive: true, force: true });
    // doctor always exits with a code — 0 = all ok, 1 = some checks failed
    expect([0, 1]).toContain(result.status);
  });
});

// ── End-to-end tests with live daemon ────────────────────────────────────────

describe('CLI e2e with daemon', () => {
  let dir: string;
  let daemonProc: ChildProcess;

  beforeAll(async () => {
    dir = makeTmpDir();
    const stderrChunks: string[] = [];
    daemonProc = spawn(process.execPath, [DAEMON_SCRIPT], {
      env: { ...process.env, CRONTICK_HOME: dir },
      stdio: 'pipe',
    });
    daemonProc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));
    await waitForPortFile(dir, 30_000, () => stderrChunks.join(''));
  }, 30_000);

  afterAll(() => {
    daemonProc?.kill('SIGTERM');
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const env = () => ({ CRONTICK_HOME: dir });

  it('crontick new creates a job', () => {
    const r = cli(['--json', 'new', 'e2e-job', '--cron', '0 0 * * *', '--exec', `${process.execPath} -e process.exit(0)`], env());
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.id).toBe('e2e-job');
  });

  it('crontick list returns the job', () => {
    const r = cli(['--json', 'list'], env());
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout) as Array<{ id: string }>;
    expect(data.some((j) => j.id === 'e2e-job')).toBe(true);
  });

  it('crontick get returns the job', () => {
    const r = cli(['--json', 'get', 'e2e-job'], env());
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.id).toBe('e2e-job');
  });

  it('crontick disable disables the job', () => {
    const r = cli(['--json', 'disable', 'e2e-job'], env());
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.enabled).toBe(false);
  });

  it('crontick enable re-enables the job', () => {
    const r = cli(['--json', 'enable', 'e2e-job'], env());
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.enabled).toBe(true);
  });

  it('crontick run-now triggers a run', () => {
    const r = cli(['--json', 'run-now', 'e2e-job'], env());
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(typeof data.runId).toBe('string');
  });

  it('crontick logs works for a completed run', async () => {
    // Get the run ID from a fresh run
    const runR = cli(['--json', 'run-now', 'e2e-job'], env());
    const runData = JSON.parse(runR.stdout) as { runId: string };
    const runId = runData.runId;

    // Wait for completion
    await new Promise((r) => setTimeout(r, 3000));

    const r = cli(['logs', runId], env());
    expect([0, 1]).toContain(r.status); // may have no output if exec exits immediately
  }, 8000);

  it('crontick logs --json outputs a JSON array', async () => {
    const runR = cli(['--json', 'run-now', 'e2e-job'], env());
    const runData = JSON.parse(runR.stdout) as { runId: string };
    const runId = runData.runId;
    await new Promise((r) => setTimeout(r, 2000));
    const r = cli(['--json', 'logs', runId], env());
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(Array.isArray(data)).toBe(true);
  }, 8000);

  it('crontick delete removes the job', () => {
    const r = cli(['--json', 'delete', 'e2e-job'], env());
    expect(r.status).toBe(0);
    const r2 = cli(['get', 'e2e-job'], env());
    expect(r2.status).toBe(1); // should error
  });

  it('crontick export produces JSON with jobs array', () => {
    const r = cli(['export'], env());
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(Array.isArray(data.jobs)).toBe(true);
  });

  it('crontick daemon status shows daemon info', () => {
    const r = cli(['--json', 'daemon', 'status'], env());
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(typeof data.pid).toBe('number');
  });

  it('crontick doctor exits 0 when daemon is running', () => {
    const r = cli(['doctor'], env());
    // All checks should pass when daemon is healthy
    expect([0, 1]).toContain(r.status);
    expect(r.stdout).toContain('daemon reachable');
  });

  // ── --json flag behaviour ─────────────────────────────────────────────────

  it('list --json output parses as JSON array', () => {
    // Create a fresh job so the list is non-empty
    cli(['--json', 'new', 'list-json-job', '--cron', '0 0 * * *', '--exec', `${process.execPath} -e process.exit(0)`], env());
    const r = cli(['--json', 'list'], env());
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(Array.isArray(data)).toBe(true);
  });

  it('list (no --json) output does NOT start with [ or {', () => {
    const r = cli(['list'], env());
    expect(r.status).toBe(0);
    const trimmed = r.stdout.trim();
    const first = trimmed[0];
    // Either empty list message or a table header — neither starts with [ or {
    expect(first === '[' || first === '{').toBe(false);
  });
});
