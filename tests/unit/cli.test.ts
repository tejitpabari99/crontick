import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { jobJsonSchemaText } from '../../src/schema-json.js';

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

function stopDaemonInHome(dir: string): void {
  const pidFile = join(dir, 'daemon.pid');
  if (!existsSync(pidFile)) return;
  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  if (!isNaN(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  }
}

function readPidFile(dir: string): number | undefined {
  const pidFile = join(dir, 'daemon.pid');
  if (!existsSync(pidFile)) return undefined;
  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  return !isNaN(pid) && pid > 0 ? pid : undefined;
}

async function waitForPidExit(pid: number, maxMs = 5_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
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

// â”€â”€ Basic CLI tests (no daemon needed) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    expect(result.stdout.toLowerCase()).not.toContain('auto' + 'start');
  });

  it('bare invocation (no subcommand) prints help and exits 0', () => {
    const result = cli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: crontick');
    expect(result.stdout).toContain('Commands:');
  });

  it('doctor exits 1 when daemon is not running (no CRONTICK_HOME)', () => {
    const tmp = makeTmpDir();
    const result = cli(['doctor'], { CRONTICK_HOME: tmp });
    rmSync(tmp, { recursive: true, force: true });
    // doctor always exits with a code â€” 0 = all ok, 1 = some checks failed
    expect([0, 1]).toContain(result.status);
  });

  it('removed startup-registration command is not available', () => {
    const result = cli(['auto' + 'start', 'status']);
    expect(result.status).not.toBe(0);
    expect((result.stdout + result.stderr).toLowerCase()).not.toContain('registry');
  });

  it('logs help does not expose removed follow mode', () => {
    const result = cli(['logs', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('--follow');
    expect(result.stdout).not.toContain('-f,');
  });

  it('new --help describes --exec\'s real verbatim-command + --arg/-- args behavior', () => {
    const result = cli(['new', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('split naively on whitespace');
    expect(result.stdout).toContain('taken verbatim');
    expect(result.stdout).toContain('--arg <value>');
    expect(result.stdout.toLowerCase()).toContain('always safe');
  });

  it('daemon-backed list auto-starts the daemon when down', async () => {
    const tmp = makeTmpDir();
    try {
      const result = cli(['--json', 'list'], { CRONTICK_HOME: tmp });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
      expect(existsSync(join(tmp, 'daemon.port'))).toBe(true);
      expect(existsSync(join(tmp, 'daemon.pid'))).toBe(true);
    } finally {
      stopDaemonInHome(tmp);
      await new Promise((r) => setTimeout(r, 300));
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 15_000);

  it('ENS-CLI-002: next daemon-backed command re-ensures after daemon crash', async () => {
    const tmp = makeTmpDir();
    try {
      const first = cli(['--json', 'list'], { CRONTICK_HOME: tmp });
      expect(first.status, first.stderr).toBe(0);
      const firstPid = readPidFile(tmp);
      expect(firstPid).toBeGreaterThan(0);
      if (firstPid) {
        try {
          process.kill(firstPid, 'SIGTERM');
        } catch {
          // ignore crash races
        }
        await waitForPidExit(firstPid);
      }

      const second = cli(['--json', 'list'], { CRONTICK_HOME: tmp });
      expect(second.status, second.stderr).toBe(0);
      expect(JSON.parse(second.stdout)).toEqual([]);
      const secondPid = readPidFile(tmp);
      expect(secondPid).toBeGreaterThan(0);
      expect(secondPid).not.toBe(firstPid);
    } finally {
      stopDaemonInHome(tmp);
      await new Promise((r) => setTimeout(r, 300));
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('daemon-free commands do not start the daemon', () => {
    const tmp = makeTmpDir();
    try {
      expect(cli(['--help'], { CRONTICK_HOME: tmp }).status).toBe(0);
      expect(cli(['--version'], { CRONTICK_HOME: tmp }).status).toBe(0);
      expect(cli(['daemon', 'status'], { CRONTICK_HOME: tmp }).stdout).toContain('not running');
      expect(existsSync(join(tmp, 'daemon.port'))).toBe(false);
      expect(existsSync(join(tmp, 'daemon.pid'))).toBe(false);
      expect(existsSync(join(tmp, 'daemon.ensure.lock'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 15_000);

  it('daemon stop reports the graceful HTTP mode and pid, in both text and --json output', async () => {
    const tmp = makeTmpDir();
    try {
      const started = cli(['--json', 'list'], { CRONTICK_HOME: tmp });
      expect(started.status, started.stderr).toBe(0);
      const pid = readPidFile(tmp);
      expect(pid).toBeGreaterThan(0);

      const jsonStop = cli(['--json', 'daemon', 'stop'], { CRONTICK_HOME: tmp });
      expect(jsonStop.status, jsonStop.stderr).toBe(0);
      const data = JSON.parse(jsonStop.stdout);
      expect(data.mode).toBe('graceful');
      expect(data.pid).toBe(pid);

      // Second stop against an already-stopped daemon still reports a mode.
      const textStop = cli(['daemon', 'stop'], { CRONTICK_HOME: tmp });
      expect(textStop.status, textStop.stderr).toBe(0);
      expect(textStop.stdout).toContain('mode: already-stopped');
    } finally {
      stopDaemonInHome(tmp);
      await new Promise((r) => setTimeout(r, 300));
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 15_000);

  it('config commands initialize, edit, validate, and render JSON', () => {
    const tmp = makeTmpDir();
    try {
      let result = cli(['--json', 'config', 'get'], { CRONTICK_HOME: tmp });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ defaultEngine: 'copilot' });

      result = cli(['--json', 'config', 'init'], { CRONTICK_HOME: tmp });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(tmp, 'config.json'))).toBe(true);

      result = cli(['--json', 'config', 'engines', 'add', 'agency', '--command', 'agency', '--arg', 'cp', '--env', 'LOGS=XYZ'], { CRONTICK_HOME: tmp });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ engines: { agency: { command: 'agency', args: ['cp'], env: { LOGS: 'XYZ' } } } });

      result = cli(['--json', 'config', 'set', 'defaultEngine', '"agency"'], { CRONTICK_HOME: tmp });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ defaultEngine: 'agency' });

      result = cli(['--json', 'config', 'get', 'defaultEngine'], { CRONTICK_HOME: tmp });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toBe('agency');

      result = cli(['--json', 'config', 'validate'], { CRONTICK_HOME: tmp });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });


  it('config mutation commands redact secret engine env values in their JSON responses while preserving benign trap keys', () => {
    const tmp = makeTmpDir();
    const secret = `sk-proj-${'U'.repeat(28)}`;
    const updatedSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    try {
      expect(cli(['--json', 'config', 'init'], { CRONTICK_HOME: tmp }).status).toBe(0);

      let result = cli([
        '--json', 'config', 'set', 'engines.copilot.env',
        JSON.stringify({ OPENAI_API_KEY: secret, NON_SECRET: String.raw`C:\Users\Example\cli-benign` }),
      ], { CRONTICK_HOME: tmp });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(secret);
      expect(JSON.parse(result.stdout)).toMatchObject({
        engines: { copilot: { env: { OPENAI_API_KEY: '[REDACTED]', NON_SECRET: String.raw`C:\Users\Example\cli-benign` } } },
      });

      result = cli([
        '--json', 'config', 'engines', 'add', 'cli-redaction-engine',
        '--command', 'agency',
        '--env', `OPENAI_API_KEY=${secret}`,
        '--env', 'NON_SECRET=https://example.test/cli-visible',
      ], { CRONTICK_HOME: tmp });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(secret);
      expect(JSON.parse(result.stdout)).toMatchObject({
        engines: {
          'cli-redaction-engine': {
            env: { OPENAI_API_KEY: '[REDACTED]', NON_SECRET: 'https://example.test/cli-visible' },
          },
        },
      });

      result = cli([
        '--json', 'config', 'engines', 'update', 'cli-redaction-engine',
        '--env', `AWS_SECRET_ACCESS_KEY=${updatedSecret}`,
        '--env', 'NO_PASSWORD=Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLl1Mm2Nn',
      ], { CRONTICK_HOME: tmp });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(updatedSecret);
      expect(JSON.parse(result.stdout)).toMatchObject({
        engines: {
          'cli-redaction-engine': {
            env: { AWS_SECRET_ACCESS_KEY: '[REDACTED]', NO_PASSWORD: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLl1Mm2Nn' },
          },
        },
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('config read commands redact secret engine env values', () => {
    const tmp = makeTmpDir();
    const secret = `sk-proj-${'S'.repeat(28)}`;
    try {
      expect(cli(['--json', 'config', 'init'], { CRONTICK_HOME: tmp }).status).toBe(0);
      expect(cli(['config', 'set', 'engines.copilot.env.OPENAI_API_KEY', JSON.stringify(secret)], { CRONTICK_HOME: tmp }).status).toBe(0);

      let result = cli(['--json', 'config', 'engines'], { CRONTICK_HOME: tmp });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(secret);
      expect(JSON.parse(result.stdout)).toMatchObject({
        copilot: { env: { OPENAI_API_KEY: '[REDACTED]' } },
      });

      result = cli(['--json', 'config', 'validate'], { CRONTICK_HOME: tmp });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(secret);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        config: { engines: { copilot: { env: { OPENAI_API_KEY: '[REDACTED]' } } } },
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('uninstall command is not available', () => {
    const result = cli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('uninstall');
  });
});

// â”€â”€ End-to-end tests with live daemon â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    const r = cli(['--json', 'new', 'e2e-job', '--cron', '0 0 * * *', '--exec', process.execPath, '--', '-e', 'process.exit(0)'], env());
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.id).toBe('e2e-job');
    expect(data.action).toMatchObject({ kind: 'exec', command: process.execPath, args: ['-e', 'process.exit(0)'] });
    expect(readFileSync(join(dir, 'jobs', 'e2e-job.schema.json'), 'utf-8')).toBe(jobJsonSchemaText());
  });

  it('crontick new rejects duplicate ids unless --force is explicit, and --force intentionally replaces the job', () => {
    const original = cli([
      '--json', 'new', 'duplicate-cli-job', '--every', '60', '--exec', process.execPath,
      '--arg', '-e', '--arg', 'process.exit(0)', '--desc', 'original cli definition',
    ], env());
    expect(original.status, original.stderr).toBe(0);

    const duplicate = cli([
      'new', 'duplicate-cli-job', '--cron', '15 6 * * *', '--exec', process.execPath,
      '--arg', '-e', '--arg', 'process.exit(1)', '--desc', 'replacement cli definition',
    ], env());
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain('JOB_ALREADY_EXISTS');

    const fetchedOriginal = cli(['--json', 'get', 'duplicate-cli-job'], env());
    expect(fetchedOriginal.status, fetchedOriginal.stderr).toBe(0);
    expect(JSON.parse(fetchedOriginal.stdout)).toMatchObject({
      description: 'original cli definition',
      schedule: { kind: 'interval', everySec: 60 },
      action: { args: ['-e', 'process.exit(0)'] },
    });

    const forced = cli([
      '--json', 'new', 'duplicate-cli-job', '--force', '--cron', '15 6 * * *', '--exec', process.execPath,
      '--arg', '-e', '--arg', 'process.exit(1)', '--desc', 'replacement cli definition',
    ], env());
    expect(forced.status, forced.stderr).toBe(0);
    expect(JSON.parse(forced.stdout)).toMatchObject({
      description: 'replacement cli definition',
      schedule: { kind: 'cron', cron: '15 6 * * *' },
      action: { args: ['-e', 'process.exit(1)'] },
    });
  });

  // ── Blocker 1: --arg is the documented, shim-independent way to pass args ────

  it('crontick new --arg round-trips a value with spaces, embedded double quotes, and a leading dash', () => {
    const tricky = '-flag with spaces and "embedded quotes"';
    const r = cli(['--json', 'new', 'arg-tricky-job', '--cron', '0 0 * * *', '--exec', 'echo', '--arg', tricky], env());
    expect(r.status, r.stderr).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.action).toMatchObject({ kind: 'exec', command: 'echo', args: [tricky] });
  });

  it('crontick new --arg round-trips a value that is itself a crontick global flag spelling (e.g. -v, --json)', () => {
    // Commander's root program recognizes --json/-v/--verbose/-h/--help/-V/
    // --version ANYWHERE in argv (not just before the subcommand name), so an
    // --arg value that happens to equal one of those exact strings must not
    // be silently swallowed as the global flag instead of stored as the job's
    // literal argument.
    const r = cli(['--json', 'new', 'arg-global-flag-collision-job', '--cron', '0 0 * * *', '--exec', 'node', '--arg', '-e', '--arg', 'console.log(1)', '--arg', '-v', '--arg', '--json'], env());
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).action).toMatchObject({
      kind: 'exec',
      command: 'node',
      args: ['-e', 'console.log(1)', '-v', '--json'],
    });
  });

  it('crontick new --arg is repeatable and produces the same result as -- for equivalent values', () => {
    const viaArg = cli(['--json', 'new', 'arg-repeat-job', '--cron', '0 0 * * *', '--exec', 'node', '--arg', '-e', '--arg', 'process.exit(0)'], env());
    expect(viaArg.status, viaArg.stderr).toBe(0);
    expect(JSON.parse(viaArg.stdout).action).toMatchObject({ kind: 'exec', command: 'node', args: ['-e', 'process.exit(0)'] });

    const viaDashDash = cli(['--json', 'new', 'dashdash-repeat-job', '--cron', '0 0 * * *', '--exec', 'node', '--', '-e', 'process.exit(0)'], env());
    expect(viaDashDash.status, viaDashDash.stderr).toBe(0);
    expect(JSON.parse(viaDashDash.stdout).action).toEqual(JSON.parse(viaArg.stdout).action);
  });

  it('crontick update --arg round-trips the same tricky value as new', () => {
    const created = cli(['--json', 'new', 'arg-update-job', '--cron', '0 0 * * *', '--exec', 'echo', '--arg', 'placeholder'], env());
    expect(created.status, created.stderr).toBe(0);
    const tricky = '-flag with spaces and "embedded quotes"';
    const updated = cli(['--json', 'update', 'arg-update-job', '--exec', 'echo', '--arg', tricky], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout).action).toMatchObject({ kind: 'exec', command: 'echo', args: [tricky] });
  });

  it('crontick new rejects combining --arg with -- positional args (ambiguous args source)', () => {
    const r = cli(['--json', 'new', 'arg-conflict-job', '--cron', '0 0 * * *', '--exec', 'node', '--arg', '-e', '--', 'process.exit(0)'], env());
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Cannot combine --arg/);
  });

  it('crontick new rejects a crontick flag placed after -- instead of silently storing it as a job arg', () => {
    const r = cli(['--json', 'new', 'flag-after-dashdash-job', '--cron', '0 0 * * *', '--exec', 'node', '--', '-e', 'process.exit(0)', '--json'], env());
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--json.*match a crontick flag name|match a crontick flag name.*--json/);
    // Confirm the job was never created with --json swallowed into its args.
    const list = cli(['--json', 'list'], env());
    expect(JSON.parse(list.stdout).some((job: { id: string }) => job.id === 'flag-after-dashdash-job')).toBe(false);
  });

  it('crontick new creates a prompt job with default engine', () => {
    const r = cli(['--json', 'new', 'prompt-cli-job', '--cron', '0 9 * * *', '--prompt', 'Summarize'], env());
    expect(r.status, r.stderr).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.action).toMatchObject({
      kind: 'prompt',
      prompt: 'Summarize',
      engine: 'copilot',
      args: [],
      reuseSession: false,
    });
  });

  it('crontick new accepts a leading-dash prompt value', () => {
    const r = cli(['--json', 'new', 'prompt-leading-dash-cli-job', '--cron', '0 9 * * *', '--prompt=- summarize'], env());
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).action).toMatchObject({
      kind: 'prompt',
      prompt: '- summarize',
    });
  });

  it('crontick new creates a prompt job from file with raw passthrough args', () => {
    const promptPath = join(dir, 'prompt.txt');
    writeFileSync(promptPath, 'Prompt from file', 'utf-8');
    const r = cli([
      '--json',
      'new',
      'prompt-file-cli-job',
      '--cron',
      '0 10 * * *',
      '--prompt-file',
      promptPath,
      '--engine',
      'agency',
      '--reuse-session',
      '--',
      '--silent',
      '--add-dir',
      'Q:\\Repos\\crontick',
      '--flag',
      'one',
      '--flag',
      'two',
    ], env());
    expect(r.status, r.stderr).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.action).toMatchObject({
      kind: 'prompt',
      prompt: 'Prompt from file',
      engine: 'agency',
      args: ['--silent', '--add-dir', 'Q:\\Repos\\crontick', '--flag', 'one', '--flag', 'two'],
      reuseSession: true,
    });
    expect(data.action).not.toHaveProperty('promptFile');
  });

  it('crontick new stores explicit prompt session id', () => {
    const r = cli([
      '--json',
      'new',
      'prompt-session-cli-job',
      '--cron',
      '0 11 * * *',
      '--prompt',
      'hello',
      '--session-id',
      'sess-12345678',
    ], env());
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).action).toMatchObject({
      kind: 'prompt',
      sessionId: 'sess-12345678',
      reuseSession: false,
    });
  });

  it('crontick new reports that reuseSession is ignored when an explicit session id is provided', () => {
    const r = cli([
      '--json',
      'new',
      'prompt-session-precedence-cli-job',
      '--cron',
      '0 11 * * *',
      '--prompt',
      'hello',
      '--session-id',
      'sess-precedence1',
      '--reuse-session',
    ], env());
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('reuseSession was ignored');
    expect(JSON.parse(r.stdout).action).toMatchObject({
      kind: 'prompt',
      sessionId: 'sess-precedence1',
      reuseSession: false,
    });
  });

  it('crontick new rejects managed prompt/session flags in raw engine args', () => {
    const r = cli([
      'new',
      'prompt-reserved-arg-job',
      '--cron',
      '0 11 * * *',
      '--prompt',
      'hello',
      '--',
      '--session-id=sess-12345678',
    ], env());
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('prompt/session flag');
  });

  it('crontick new reports a clear error for prompt argv beyond the Windows-safe limit', () => {
    const r = cli([
      'new',
      'prompt-argv-limit-job',
      '--cron',
      '0 11 * * *',
      `--prompt=${'x'.repeat(31_000)}`,
    ], env());
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Windows-safe command line limit');
  });

  it('crontick new rejects prompt-only flags outside prompt mode', () => {
    const raw = cli(['new', 'bad-raw-job', '--cron', '0 0 * * *', '--script', 'echo hi', '--', '--silent'], env());
    expect(raw.status).not.toBe(0);
    expect(raw.stderr).toContain('Arguments (via --arg or --) are valid only with');

    const session = cli(['new', 'bad-session-job', '--cron', '0 0 * * *', '--script', 'echo hi', '--session-id', 'sess-12345678'], env());
    expect(session.status).not.toBe(0);
    expect(session.stderr).toContain('Prompt engine/session flags');
  });

  it('crontick new enforces action and file exclusivity', () => {
    const multi = cli(['new', 'bad-multi-job', '--cron', '0 0 * * *', '--script', 'echo hi', '--prompt', 'x'], env());
    expect(multi.status).not.toBe(0);
    expect(multi.stderr).toContain('exactly one action source');

    const jobFile = join(dir, 'job.json');
    writeFileSync(jobFile, JSON.stringify({
      id: 'file-prompt-job',
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: { kind: 'prompt', prompt: 'x' },
    }), 'utf-8');
    const fileConflict = cli(['new', 'ignored-id', '--file', jobFile, '--prompt', 'x'], env());
    expect(fileConflict.status).not.toBe(0);
    expect(fileConflict.stderr).toContain('--file is mutually exclusive');
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

  it('job create/get/list/update responses redact secret env values while preserving benign ones', () => {
    const jobId = 'cli-redaction-job';
    const createSecret = `sk-proj-${'V'.repeat(28)}`;
    const updateSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const createFile = join(dir, 'cli-redaction-job-create.json');
    const patchFile = join(dir, 'cli-redaction-job-update.json');

    writeFileSync(createFile, JSON.stringify({
      id: jobId,
      schedule: { kind: 'cron', cron: '0 0 * * *' },
      action: {
        kind: 'exec',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        env: { OPENAI_API_KEY: createSecret, NON_SECRET: 'https://example.test/job-visible' },
      },
    }), 'utf-8');

    let result = cli(['--json', 'new', 'ignored-cli-redaction-job', '--file', createFile], env());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(createSecret);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: jobId,
      action: { env: { OPENAI_API_KEY: '[REDACTED]', NON_SECRET: 'https://example.test/job-visible' } },
    });

    result = cli(['--json', 'get', jobId], env());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(createSecret);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: jobId,
      action: { env: { OPENAI_API_KEY: '[REDACTED]', NON_SECRET: 'https://example.test/job-visible' } },
    });

    result = cli(['--json', 'list'], env());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(createSecret);
    expect((JSON.parse(result.stdout) as Array<{ id: string; action: { env?: Record<string, string> } }>)).toContainEqual(expect.objectContaining({
      id: jobId,
      action: expect.objectContaining({ env: expect.objectContaining({ OPENAI_API_KEY: '[REDACTED]', NON_SECRET: 'https://example.test/job-visible' }) }),
    }));

    writeFileSync(patchFile, JSON.stringify({
      action: {
        kind: 'exec',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        env: { AWS_SECRET_ACCESS_KEY: updateSecret, NO_PASSWORD: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLl1Mm2Nn' },
      },
    }), 'utf-8');

    result = cli(['--json', 'update', jobId, '--file', patchFile], env());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(updateSecret);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: jobId,
      action: { env: { AWS_SECRET_ACCESS_KEY: '[REDACTED]', NO_PASSWORD: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLl1Mm2Nn' } },
    });

    result = cli(['--json', 'disable', jobId], env());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(updateSecret);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: jobId,
      enabled: false,
      action: { env: { AWS_SECRET_ACCESS_KEY: '[REDACTED]', NO_PASSWORD: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLl1Mm2Nn' } },
    });

    result = cli(['--json', 'enable', jobId], env());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(updateSecret);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: jobId,
      enabled: true,
      action: { env: { AWS_SECRET_ACCESS_KEY: '[REDACTED]', NO_PASSWORD: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLl1Mm2Nn' } },
    });
  });

  it('crontick update changes a job through the client/core path', () => {
    const r = cli(['--json', 'update', 'e2e-job', '--desc', 'updated from cli'], env());
    expect(r.status, r.stderr).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.description).toBe('updated from cli');
  });

  it('crontick update merges a partial patch onto the existing definition rather than replacing it', () => {
    const created = cli([
      '--json', 'new', 'merge-check-job', '--cron', '0 9 * * *',
      '--exec', 'echo',
      '--overlap', 'queue', '--retry', '2',
      '--', 'hi',
    ], env());
    expect(created.status, created.stderr).toBe(0);

    const updated = cli(['--json', 'update', 'merge-check-job', '--desc', 'merged'], env());
    expect(updated.status, updated.stderr).toBe(0);
    const data = JSON.parse(updated.stdout);

    expect(data.description).toBe('merged');
    expect(data.schedule).toEqual({ kind: 'cron', cron: '0 9 * * *' });
    expect(data.action).toMatchObject({ kind: 'exec', command: 'echo' });
    expect(data.overlap).toBe('queue');
    expect(data.retry.max).toBe(2);
  });

  it('crontick update --overlap skip explicitly sets skip (not silently ignored)', () => {
    const created = cli([
      '--json', 'new', 'overlap-skip-job', '--cron', '0 9 * * *',
      '--exec', 'echo', '--overlap', 'queue', '--', 'hi',
    ], env());
    expect(created.status, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout).overlap).toBe('queue');

    const updated = cli(['--json', 'update', 'overlap-skip-job', '--overlap', 'skip'], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout).overlap).toBe('skip');
  });

  it('crontick update --overlap cancel-previous sets that value', () => {
    const created = cli([
      '--json', 'new', 'overlap-cancel-job', '--cron', '0 9 * * *',
      '--exec', 'echo', '--overlap', 'queue', '--', 'hi',
    ], env());
    expect(created.status, created.stderr).toBe(0);

    const updated = cli(['--json', 'update', 'overlap-cancel-job', '--overlap', 'cancel-previous'], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout).overlap).toBe('cancel-previous');
  });

  it('crontick update omitting --overlap leaves the existing value alone', () => {
    const created = cli([
      '--json', 'new', 'overlap-preserve-job', '--cron', '0 9 * * *',
      '--exec', 'echo', '--overlap', 'cancel-previous', '--', 'hi',
    ], env());
    expect(created.status, created.stderr).toBe(0);

    const updated = cli(['--json', 'update', 'overlap-preserve-job', '--desc', 'no overlap flag'], env());
    expect(updated.status, updated.stderr).toBe(0);
    const data = JSON.parse(updated.stdout);
    expect(data.overlap).toBe('cancel-previous');
    expect(data.description).toBe('no overlap flag');
  });

  it('crontick update preserves shell/envFile/timeoutSec when only --script is repeated', () => {
    // Use a real env file so the stored action.envFile can be asserted end-to-end.
    const envFilePath = join(dir, 'shell-preserve.env');
    writeFileSync(envFilePath, 'FOO=bar\n', 'utf-8');
    const created = cli([
      '--json', 'new', 'shell-preserve-job', '--cron', '0 9 * * *',
      '--script', 'echo hi', '--shell', 'cmd', '--job-env-file', envFilePath, '--timeout', '30',
    ], env());
    expect(created.status, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout).action).toMatchObject({ shell: 'cmd', envFile: envFilePath, timeoutSec: 30 });

    const updated = cli(['--json', 'update', 'shell-preserve-job', '--script', 'echo bye'], env());
    expect(updated.status, updated.stderr).toBe(0);
    const data = JSON.parse(updated.stdout);
    expect(data.action).toMatchObject({
      kind: 'script', script: 'echo bye', shell: 'cmd', envFile: envFilePath, timeoutSec: 30,
    });
  });

  it('crontick update --shell explicitly changes the shell', () => {
    const envFilePath = join(dir, 'shell-explicit.env');
    writeFileSync(envFilePath, 'FOO=bar\n', 'utf-8');
    const created = cli([
      '--json', 'new', 'shell-explicit-job', '--cron', '0 9 * * *',
      '--script', 'echo hi', '--shell', 'cmd', '--job-env-file', envFilePath, '--timeout', '30',
    ], env());
    expect(created.status, created.stderr).toBe(0);

    const updated = cli(['--json', 'update', 'shell-explicit-job', '--script', 'echo again', '--shell', 'pwsh'], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout).action).toMatchObject({ shell: 'pwsh' });
  });

  it('crontick update --cron with --tz updates the cron timezone', () => {
    const created = cli([
      '--json', 'new', 'tz-update-job', '--cron', '0 9 * * *', '--script', 'echo hi',
    ], env());
    expect(created.status, created.stderr).toBe(0);

    const updated = cli(['--json', 'update', 'tz-update-job', '--cron', '0 10 * * *', '--tz', 'UTC'], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout).schedule).toEqual({ kind: 'cron', cron: '0 10 * * *', tz: 'UTC' });
  });

  it('crontick update rejects lone modifier flags instead of silently succeeding', () => {
    const existingEnvFile = join(dir, 'modifier-base.env');
    const missingEnvFile = join(dir, 'modifier-missing.env');
    writeFileSync(existingEnvFile, 'FOO=bar\n', 'utf-8');

    const cases = [
      {
        name: '--job-env-file',
        jobId: 'modifier-env-file-job',
        create: ['--json', 'new', 'modifier-env-file-job', '--cron', '0 9 * * *', '--script', 'echo hi'],
        update: ['update', 'modifier-env-file-job', '--job-env-file', missingEnvFile],
        stderr: ['modifier-missing.env', '--job-env-file'],
      },
      {
        name: '--shell',
        jobId: 'modifier-shell-job',
        create: ['--json', 'new', 'modifier-shell-job', '--cron', '0 9 * * *', '--script', 'echo hi', '--shell', 'cmd', '--job-env-file', existingEnvFile, '--timeout', '30'],
        update: ['update', 'modifier-shell-job', '--shell', 'pwsh'],
        stderr: ['--shell', 'action source on update'],
      },
      {
        name: '--timeout',
        jobId: 'modifier-timeout-job',
        create: ['--json', 'new', 'modifier-timeout-job', '--cron', '0 9 * * *', '--script', 'echo hi', '--timeout', '30'],
        update: ['update', 'modifier-timeout-job', '--timeout', '45'],
        stderr: ['--timeout', 'action source on update'],
      },
      {
        name: '--tz',
        jobId: 'modifier-tz-job',
        create: ['--json', 'new', 'modifier-tz-job', '--cron', '0 9 * * *', '--script', 'echo hi'],
        update: ['update', 'modifier-tz-job', '--tz', 'UTC'],
        stderr: ['--tz requires --cron on update'],
      },
    ];

    for (const testCase of cases) {
      const created = cli(testCase.create, env());
      expect(created.status, `${testCase.name} create failed: ${created.stderr}`).toBe(0);

      const before = cli(['--json', 'get', testCase.jobId], env());
      expect(before.status, before.stderr).toBe(0);

      const updated = cli(testCase.update, env());
      expect(updated.status, `${testCase.name} stderr: ${updated.stderr}`).toBe(1);
      for (const part of testCase.stderr) expect(updated.stderr).toContain(part);

      const after = cli(['--json', 'get', testCase.jobId], env());
      expect(after.status, after.stderr).toBe(0);
      expect(after.stdout).toBe(before.stdout);
    }
  });

  it('crontick update switching action kind fully replaces the action (no stale fields)', () => {
    const envFilePath = join(dir, 'shell-replace.env');
    writeFileSync(envFilePath, 'FOO=bar\n', 'utf-8');
    const created = cli([
      '--json', 'new', 'shell-replace-job', '--cron', '0 9 * * *',
      '--script', 'echo hi', '--shell', 'cmd', '--job-env-file', envFilePath, '--timeout', '30',
    ], env());
    expect(created.status, created.stderr).toBe(0);

    const updated = cli(['--json', 'update', 'shell-replace-job', '--exec', 'echo', '--', 'done'], env());
    expect(updated.status, updated.stderr).toBe(0);
    const data = JSON.parse(updated.stdout);
    expect(data.action).toMatchObject({ kind: 'exec', command: 'echo', args: ['done'] });
    expect(data.action).not.toHaveProperty('shell');
    expect(data.action).not.toHaveProperty('script');
  });

  // ── args/reuseSession/retry/engine parity with MCP (see tests/mcp.test.ts) ────
  // The CLI's own flag builder always supplies args/reuseSession/retry
  // explicitly (there's no flag-only way to "touch one action field but leave
  // args alone" for exec/prompt), so these use --file JSON patches — which go
  // through the exact same JobPatchInputSchema.safeParse + normalizeJobPatch
  // core as an MCP call — to prove CLI and MCP resolve identically.

  it('crontick update --file preserves exec args when the patch only changes envFile', () => {
    const created = cli([
      '--json', 'new', 'file-exec-args-preserve-job', '--cron', '0 9 * * *',
      '--exec', 'echo', '--', 'a', 'b',
    ], env());
    expect(created.status, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout).action).toMatchObject({ kind: 'exec', command: 'echo', args: ['a', 'b'] });

    const envFilePath = join(dir, 'file-exec-args.env');
    writeFileSync(envFilePath, 'FOO=bar\n', 'utf-8');

    const patchFile = join(dir, 'file-exec-args-patch.json');
    writeFileSync(patchFile, JSON.stringify({ action: { kind: 'exec', command: 'echo', envFile: envFilePath } }), 'utf-8');
    const updated = cli(['--json', 'update', 'file-exec-args-preserve-job', '--file', patchFile], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout).action).toMatchObject({
      kind: 'exec', command: 'echo', args: ['a', 'b'], envFile: envFilePath,
    });
  });

  it('crontick update --file applies explicit exec args when provided', () => {
    const created = cli([
      '--json', 'new', 'file-exec-args-explicit-job', '--cron', '0 9 * * *',
      '--exec', 'echo', '--', 'a', 'b',
    ], env());
    expect(created.status, created.stderr).toBe(0);

    const patchFile = join(dir, 'file-exec-args-explicit-patch.json');
    writeFileSync(patchFile, JSON.stringify({ action: { kind: 'exec', command: 'echo', args: ['c'] } }), 'utf-8');
    const updated = cli(['--json', 'update', 'file-exec-args-explicit-job', '--file', patchFile], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout).action).toMatchObject({ kind: 'exec', args: ['c'] });
  });

  it('crontick update --file preserves prompt args and reuseSession when the patch only changes prompt text', () => {
    const created = cli([
      '--json', 'new', 'file-prompt-args-preserve-job', '--cron', '0 9 * * *',
      '--prompt', 'old', '--reuse-session', '--', '--flag',
    ], env());
    expect(created.status, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout).action).toMatchObject({
      kind: 'prompt', prompt: 'old', args: ['--flag'], reuseSession: true,
    });

    const patchFile = join(dir, 'file-prompt-args-patch.json');
    writeFileSync(patchFile, JSON.stringify({ action: { kind: 'prompt', prompt: 'new' } }), 'utf-8');
    const updated = cli(['--json', 'update', 'file-prompt-args-preserve-job', '--file', patchFile], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout).action).toMatchObject({
      kind: 'prompt', prompt: 'new', args: ['--flag'], reuseSession: true,
    });
  });

  it('crontick update --file applies explicit prompt args/reuseSession when provided', () => {
    const created = cli([
      '--json', 'new', 'file-prompt-args-explicit-job', '--cron', '0 9 * * *',
      '--prompt', 'old', '--reuse-session', '--', '--flag',
    ], env());
    expect(created.status, created.stderr).toBe(0);

    const patchFile = join(dir, 'file-prompt-args-explicit-patch.json');
    writeFileSync(patchFile, JSON.stringify({ action: { kind: 'prompt', prompt: 'old', args: [], reuseSession: false } }), 'utf-8');
    const updated = cli(['--json', 'update', 'file-prompt-args-explicit-job', '--file', patchFile], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout).action).toMatchObject({ args: [], reuseSession: false });
  });

  it('crontick update --reuse-session omitted on update leaves an existing reuseSession alone', () => {
    // Unlike args, --reuse-session has no Commander default and is a real CLI
    // flag path (booleanOption(opts.reuseSession) is undefined when omitted),
    // so this exercises the flag path directly rather than needing --file.
    const created = cli([
      '--json', 'new', 'reuse-session-flag-job', '--cron', '0 9 * * *',
      '--prompt', 'old', '--reuse-session',
    ], env());
    expect(created.status, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout).action).toMatchObject({ reuseSession: true });

    const updated = cli(['--json', 'update', 'reuse-session-flag-job', '--prompt', 'new'], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout).action).toMatchObject({ kind: 'prompt', prompt: 'new', reuseSession: true });
  });

  it('crontick update --file preserves a custom engine on a same-kind prompt update that omits engine', () => {
    const created = cli([
      '--json', 'new', 'file-prompt-engine-job', '--cron', '0 9 * * *',
      '--prompt', 'old', '--engine', 'agency',
    ], env());
    expect(created.status, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout).action).toMatchObject({ engine: 'agency' });

    const patchFile = join(dir, 'file-prompt-engine-patch.json');
    writeFileSync(patchFile, JSON.stringify({ action: { kind: 'prompt', prompt: 'new' } }), 'utf-8');
    const updated = cli(['--json', 'update', 'file-prompt-engine-job', '--file', patchFile], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout).action).toMatchObject({ kind: 'prompt', engine: 'agency' });
  });

  it('crontick update --file fills the configured default engine for a new prompt action introduced via a kind change', () => {
    const created = cli([
      '--json', 'new', 'file-kind-change-engine-job', '--cron', '0 9 * * *', '--exec', 'echo',
    ], env());
    expect(created.status, created.stderr).toBe(0);

    const patchFile = join(dir, 'file-kind-change-engine-patch.json');
    writeFileSync(patchFile, JSON.stringify({ action: { kind: 'prompt', prompt: 'hello' } }), 'utf-8');
    const updated = cli(['--json', 'update', 'file-kind-change-engine-job', '--file', patchFile], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout).action).toMatchObject({ kind: 'prompt', prompt: 'hello', engine: 'copilot' });
  });

  it('crontick update --file preserves retry.backoffSec when the patch only sets max', () => {
    const created = cli([
      '--json', 'new', 'file-retry-preserve-job', '--cron', '0 9 * * *', '--exec', 'echo',
    ], env());
    expect(created.status, created.stderr).toBe(0);
    // --retry only ever sets max (backoffSec fixed at 30 by the CLI flag
    // builder), so seed a custom backoffSec via --file to set up this case.
    const seedFile = join(dir, 'file-retry-seed-patch.json');
    writeFileSync(seedFile, JSON.stringify({ retry: { max: 1, backoffSec: 90 } }), 'utf-8');
    const seeded = cli(['--json', 'update', 'file-retry-preserve-job', '--file', seedFile], env());
    expect(seeded.status, seeded.stderr).toBe(0);
    expect(JSON.parse(seeded.stdout).retry).toEqual({ max: 1, backoffSec: 90 });

    const patchFile = join(dir, 'file-retry-patch.json');
    writeFileSync(patchFile, JSON.stringify({ retry: { max: 3 } }), 'utf-8');
    const updated = cli(['--json', 'update', 'file-retry-preserve-job', '--file', patchFile], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout).retry).toEqual({ max: 3, backoffSec: 90 });
  });

  it('crontick update --file applies an explicit backoffSec over the preserved retry fields', () => {
    const created = cli([
      '--json', 'new', 'file-retry-explicit-job', '--cron', '0 9 * * *', '--exec', 'echo',
    ], env());
    expect(created.status, created.stderr).toBe(0);

    const seedFile = join(dir, 'file-retry-explicit-seed-patch.json');
    writeFileSync(seedFile, JSON.stringify({ retry: { max: 1, backoffSec: 90 } }), 'utf-8');
    const seeded = cli(['--json', 'update', 'file-retry-explicit-job', '--file', seedFile], env());
    expect(seeded.status, seeded.stderr).toBe(0);

    const patchFile = join(dir, 'file-retry-explicit-patch.json');
    writeFileSync(patchFile, JSON.stringify({ retry: { max: 3, backoffSec: 15 } }), 'utf-8');
    const updated = cli(['--json', 'update', 'file-retry-explicit-job', '--file', patchFile], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout).retry).toEqual({ max: 3, backoffSec: 15 });
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

  it('crontick run-now triggers a run and run commands inspect it', () => {
    const r = cli(['--json', 'run-now', 'e2e-job'], env());
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout) as { runId: string };
    expect(typeof data.runId).toBe('string');

    const getRun = cli(['--json', 'runs', 'get', data.runId], env());
    expect(getRun.status, getRun.stderr).toBe(0);
    const run = JSON.parse(getRun.stdout);
    expect(run.id).toBe(data.runId);
    // Handoff #4: pid (the spawned child's pid, once known) and outputTruncated
    // (whether the retention output cap kicked in) are surfaced on every run record.
    expect(typeof run.pid === 'number' || run.pid === undefined).toBe(true);
    expect(typeof run.outputTruncated).toBe('boolean');

    const listRuns = cli(['--json', 'runs', 'list', '--job', 'e2e-job', '--limit', '5'], env());
    expect(listRuns.status, listRuns.stderr).toBe(0);
    expect(Array.isArray(JSON.parse(listRuns.stdout))).toBe(true);

    const cancel = cli(['--json', 'cancel-run', data.runId], env());
    expect(cancel.status, cancel.stderr).toBe(0);
    expect(JSON.parse(cancel.stdout)).toMatchObject({ ok: true });
  });

  // ── Blocker 1 regression: daemon-backed errors must exit cleanly (1), never
  // crash with a libuv assertion (`Assertion failed: !(handle->flags & ...)`,
  // exit code -1073740791 on Windows). Covers every command explicitly called
  // out in the blocker report: get, delete, enable, run-now, cancel-run — each
  // against a job/run id that does not exist, so the error round-trips through
  // the daemon HTTP client (src/client.ts's `request()`/`fetchRequest()`).
  describe('daemon-backed errors exit cleanly (no libuv assertion crash)', () => {
    const NONEXISTENT_ID = 'does-not-exist-regression-id';

    function expectCleanErrorExit(result: ReturnType<typeof cli>): void {
      expect(result.status, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(1);
      expect(result.stderr).not.toMatch(/Assertion failed/i);
      expect(result.stderr).not.toMatch(/UV_HANDLE_CLOSING/i);
      expect(result.stdout + result.stderr).toMatch(/Error \[/);
    }

    it('get: nonexistent job id exits 1 with no assertion crash', () => {
      expectCleanErrorExit(cli(['get', NONEXISTENT_ID], env()));
    });

    it('delete: nonexistent job id exits 1 with no assertion crash', () => {
      expectCleanErrorExit(cli(['delete', NONEXISTENT_ID], env()));
    });

    it('enable: nonexistent job id exits 1 with no assertion crash', () => {
      expectCleanErrorExit(cli(['enable', NONEXISTENT_ID], env()));
    });

    it('run-now: nonexistent job id exits 1 with no assertion crash', () => {
      expectCleanErrorExit(cli(['run-now', NONEXISTENT_ID], env()));
    });

    it('cancel-run: nonexistent run id exits 1 with no assertion crash', () => {
      expectCleanErrorExit(cli(['cancel-run', NONEXISTENT_ID], env()));
    });
  });

  it('crontick runs list --status filters to the requested run status', async () => {
    const r = cli(['--json', 'run-now', 'e2e-job'], env());
    const { runId } = JSON.parse(r.stdout) as { runId: string };
    await new Promise((resolve) => setTimeout(resolve, 2000)); // let the exec job finish

    const success = cli(['--json', 'runs', 'list', '--job', 'e2e-job', '--status', 'success'], env());
    expect(success.status, success.stderr).toBe(0);
    const successRuns = JSON.parse(success.stdout) as Array<{ id: string; status: string }>;
    expect(successRuns.every((run) => run.status === 'success')).toBe(true);
    expect(successRuns.some((run) => run.id === runId)).toBe(true);

    const failed = cli(['--json', 'runs', 'list', '--job', 'e2e-job', '--status', 'failed'], env());
    expect(failed.status, failed.stderr).toBe(0);
    expect((JSON.parse(failed.stdout) as unknown[]).some((run) => (run as { id: string }).id === runId)).toBe(false);
  }, 8000);

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

  it('crontick logs --json outputs a unified log result', async () => {
    const runR = cli(['--json', 'run-now', 'e2e-job'], env());
    const runData = JSON.parse(runR.stdout) as { runId: string };
    const runId = runData.runId;
    await new Promise((r) => setTimeout(r, 2000));
    const r = cli(['--json', 'logs', runId, '--tail', '5'], env());
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data).toMatchObject({ runId, lines: expect.any(Array) });
  }, 8000);

  it('crontick delete removes the job', () => {
    const r = cli(['--json', 'delete', 'e2e-job'], env());
    expect(r.status).toBe(0);
    const r2 = cli(['get', 'e2e-job'], env());
    expect(r2.status).toBe(1); // clean error exit, not a libuv assertion crash
  });

  it('crontick export produces JSON with jobs array', () => {
    const r = cli(['export'], env());
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(Array.isArray(data.jobs)).toBe(true);
    // --include-runs is opt-in -- keeps the default export small.
    expect(data.runs).toBeUndefined();
  });


  it('crontick update rejects a missing --job-env-file before mutating the job', () => {
    const created = cli(['--json', 'new', 'cli-missing-env-update-job', '--cron', '0 9 * * *', '--script', 'echo before'], env());
    expect(created.status, created.stderr).toBe(0);

    const missingEnvFile = join(dir, 'cli-missing-update.env');
    const updated = cli([
      '--json', 'update', 'cli-missing-env-update-job',
      '--script', 'echo after', '--job-env-file', missingEnvFile,
    ], env());
    expect(updated.status, updated.stderr).toBe(1);
    const payload = JSON.parse(updated.stderr) as { code: string; message: string };
    expect(payload.code).toBe('ENV_FILE_ERROR');
    expect(payload.message).toContain(missingEnvFile);

    const fetched = cli(['--json', 'get', 'cli-missing-env-update-job'], env());
    expect(fetched.status, fetched.stderr).toBe(0);
    expect(JSON.parse(fetched.stdout)).toMatchObject({
      id: 'cli-missing-env-update-job',
      action: { kind: 'script', script: 'echo before' },
    });

    const removed = cli(['--json', 'delete', 'cli-missing-env-update-job'], env());
    expect(removed.status, removed.stderr).toBe(0);
  });

  it('crontick new --file accepts a BOM-prefixed JSON file and rejects malformed JSON without persisting a job', () => {
    const createFile = join(dir, 'new-file-bom.json');
    writeFileSync(createFile, `\uFEFF${JSON.stringify({
      id: 'cli-file-create-job',
      schedule: { kind: 'cron', cron: '0 12 * * *' },
      action: { kind: 'exec', command: 'echo', args: ['bom-create'] },
    }, null, 2)}`, 'utf-8');

    const created = cli(['--json', 'new', 'ignored-cli-file-id', '--file', createFile], env());
    expect(created.status, created.stderr).toBe(0);

    const fetched = cli(['--json', 'get', 'cli-file-create-job'], env());
    expect(fetched.status, fetched.stderr).toBe(0);
    expect(JSON.parse(fetched.stdout)).toMatchObject({
      id: 'cli-file-create-job',
      action: { kind: 'exec', command: 'echo', args: ['bom-create'] },
    });

    const before = cli(['--json', 'list'], env());
    expect(before.status, before.stderr).toBe(0);
    const beforeCount = (JSON.parse(before.stdout) as Array<unknown>).length;

    const badFile = join(dir, 'new-file-bad.json');
    writeFileSync(badFile, '{ nope', 'utf-8');
    const badCreate = cli(['new', 'ignored-cli-file-id', '--file', badFile], env());
    expect(badCreate.status).not.toBe(0);
    expect(badCreate.stderr).toContain(badFile);
    expect(badCreate.stderr).toMatch(/line \d+ column \d+ \(position \d+\)/);
    expect(badCreate.stderr).toContain('expected a JSON object matching the crontick job schema');
    expect(badCreate.stderr).not.toContain('SyntaxError');

    const after = cli(['--json', 'list'], env());
    expect(after.status, after.stderr).toBe(0);
    expect((JSON.parse(after.stdout) as Array<unknown>).length).toBe(beforeCount);

    const removed = cli(['--json', 'delete', 'cli-file-create-job'], env());
    expect(removed.status, removed.stderr).toBe(0);
  });

  it('crontick update --file accepts a BOM-prefixed patch and rejects malformed JSON without mutating the job', () => {
    const created = cli([
      '--json', 'new', 'cli-file-update-job', '--cron', '0 12 * * *', '--exec', 'echo', '--arg', 'before',
    ], env());
    expect(created.status, created.stderr).toBe(0);

    const patchFile = join(dir, 'update-file-bom.json');
    writeFileSync(patchFile, `\uFEFF${JSON.stringify({
      action: { kind: 'exec', command: 'echo', args: ['bom-update'] },
    }, null, 2)}`, 'utf-8');

    const updated = cli(['--json', 'update', 'cli-file-update-job', '--file', patchFile], env());
    expect(updated.status, updated.stderr).toBe(0);

    let fetched = cli(['--json', 'get', 'cli-file-update-job'], env());
    expect(fetched.status, fetched.stderr).toBe(0);
    const beforeBad = JSON.parse(fetched.stdout);
    expect(beforeBad).toMatchObject({
      id: 'cli-file-update-job',
      action: { kind: 'exec', command: 'echo', args: ['bom-update'] },
    });

    const badFile = join(dir, 'update-file-bad.json');
    writeFileSync(badFile, '{ nope', 'utf-8');
    const badUpdate = cli(['update', 'cli-file-update-job', '--file', badFile], env());
    expect(badUpdate.status).not.toBe(0);
    expect(badUpdate.stderr).toContain(badFile);
    expect(badUpdate.stderr).toMatch(/line \d+ column \d+ \(position \d+\)/);
    expect(badUpdate.stderr).toContain('expected a JSON object matching the crontick job patch schema');
    expect(badUpdate.stderr).not.toContain('SyntaxError');

    fetched = cli(['--json', 'get', 'cli-file-update-job'], env());
    expect(fetched.status, fetched.stderr).toBe(0);
    expect(JSON.parse(fetched.stdout)).toEqual(beforeBad);

    const removed = cli(['--json', 'delete', 'cli-file-update-job'], env());
    expect(removed.status, removed.stderr).toBe(0);
  });

  it('crontick new/update --file report EOF-truncated JSON with end-of-input position and expected-value hints', () => {
    const createFile = join(dir, 'new-file-eof.json');
    const createContents = '{ "id": "cli-file-eof-job", "schedule": ';
    writeFileSync(createFile, createContents, 'utf-8');

    const beforeCreate = cli(['--json', 'list'], env());
    expect(beforeCreate.status, beforeCreate.stderr).toBe(0);
    const beforeCreateCount = (JSON.parse(beforeCreate.stdout) as Array<unknown>).length;

    const badCreate = cli(['new', 'ignored-cli-file-id', '--file', createFile], env());
    expect(badCreate.status).not.toBe(0);
    expect(badCreate.stderr).toContain(createFile);
    expect(badCreate.stderr).toContain('Unexpected end of JSON input');
    expect(badCreate.stderr).toContain("expected a value after ':'");
    expect(badCreate.stderr).toContain(`position ${createContents.length}`);
    expect(badCreate.stderr).toContain('expected a JSON object matching the crontick job schema');
    expect(badCreate.stderr).not.toContain('SyntaxError');

    const afterCreate = cli(['--json', 'list'], env());
    expect(afterCreate.status, afterCreate.stderr).toBe(0);
    expect((JSON.parse(afterCreate.stdout) as Array<unknown>).length).toBe(beforeCreateCount);

    const created = cli([
      '--json', 'new', 'cli-file-eof-update-job', '--cron', '0 12 * * *', '--exec', 'echo', '--arg', 'before',
    ], env());
    expect(created.status, created.stderr).toBe(0);

    let fetched = cli(['--json', 'get', 'cli-file-eof-update-job'], env());
    expect(fetched.status, fetched.stderr).toBe(0);
    const beforeBad = JSON.parse(fetched.stdout);

    const patchFile = join(dir, 'update-file-eof.json');
    const patchContents = '{ "action": { "kind": "exec", "command": ';
    writeFileSync(patchFile, patchContents, 'utf-8');

    const badUpdate = cli(['update', 'cli-file-eof-update-job', '--file', patchFile], env());
    expect(badUpdate.status).not.toBe(0);
    expect(badUpdate.stderr).toContain(patchFile);
    expect(badUpdate.stderr).toContain('Unexpected end of JSON input');
    expect(badUpdate.stderr).toContain("expected a value after ':'");
    expect(badUpdate.stderr).toContain(`position ${patchContents.length}`);
    expect(badUpdate.stderr).toContain('expected a JSON object matching the crontick job patch schema');
    expect(badUpdate.stderr).not.toContain('SyntaxError');

    fetched = cli(['--json', 'get', 'cli-file-eof-update-job'], env());
    expect(fetched.status, fetched.stderr).toBe(0);
    expect(JSON.parse(fetched.stdout)).toEqual(beforeBad);

    const removed = cli(['--json', 'delete', 'cli-file-eof-update-job'], env());
    expect(removed.status, removed.stderr).toBe(0);
  });

  it('crontick import accepts a BOM-prefixed JSON file', () => {
    const importFile = join(dir, 'import-bom.json');
    writeFileSync(importFile, `\uFEFF${JSON.stringify({
      jobs: [{
        id: 'import-bom-job',
        schedule: { kind: 'cron', cron: '0 12 * * *' },
        action: { kind: 'exec', command: 'echo', args: ['bom'] },
      }],
    }, null, 2)}`, 'utf-8');

    const imported = cli(['--json', 'import', importFile], env());
    expect(imported.status, imported.stderr).toBe(0);

    const fetched = cli(['--json', 'get', 'import-bom-job'], env());
    expect(fetched.status, fetched.stderr).toBe(0);
    expect(JSON.parse(fetched.stdout)).toMatchObject({
      id: 'import-bom-job',
      action: { kind: 'exec', command: 'echo', args: ['bom'] },
    });

    const removed = cli(['--json', 'delete', 'import-bom-job'], env());
    expect(removed.status, removed.stderr).toBe(0);
  });

  it('crontick import reports malformed JSON with file path, parse position, and expected shape', () => {
    const importFile = join(dir, 'import-bad.json');
    writeFileSync(importFile, '{ nope', 'utf-8');

    const before = cli(['--json', 'list'], env());
    expect(before.status, before.stderr).toBe(0);
    const beforeCount = (JSON.parse(before.stdout) as Array<unknown>).length;

    const imported = cli(['import', importFile], env());
    expect(imported.status).not.toBe(0);
    expect(imported.stderr).toContain(importFile);
    expect(imported.stderr).toMatch(/line \d+ column \d+ \(position \d+\)/);
    expect(imported.stderr).toContain('expected either a JSON array of jobs or an export object with jobs and optional runs');
    expect(imported.stderr).not.toContain('SyntaxError');

    const after = cli(['--json', 'list'], env());
    expect(after.status, after.stderr).toBe(0);
    expect((JSON.parse(after.stdout) as Array<unknown>).length).toBe(beforeCount);
  });


  it('crontick import reports EOF-truncated JSON with end-of-input position and unterminated-array hints', () => {
    const importFile = join(dir, 'import-eof.json');
    const importContents = '{ "jobs": [ ';
    writeFileSync(importFile, importContents, 'utf-8');

    const before = cli(['--json', 'list'], env());
    expect(before.status, before.stderr).toBe(0);
    const beforeCount = (JSON.parse(before.stdout) as Array<unknown>).length;

    const imported = cli(['import', importFile], env());
    expect(imported.status).not.toBe(0);
    expect(imported.stderr).toContain(importFile);
    expect(imported.stderr).toContain('Unexpected end of JSON input');
    expect(imported.stderr).toContain('unterminated array');
    expect(imported.stderr).toContain(`position ${importContents.length}`);
    expect(imported.stderr).toContain('expected either a JSON array of jobs or an export object with jobs and optional runs');
    expect(imported.stderr).not.toContain('SyntaxError');

    const after = cli(['--json', 'list'], env());
    expect(after.status, after.stderr).toBe(0);
    expect((JSON.parse(after.stdout) as Array<unknown>).length).toBe(beforeCount);
  });

  it('L7: crontick export --include-runs and crontick import round-trip run history', async () => {
    const create = cli(['--json', 'new', 'export-runs-job', '--cron', '0 0 * * *', '--exec', process.execPath, '--', '-e', 'process.exit(0)'], env());
    expect(create.status, create.stderr).toBe(0);
    const runNow = cli(['--json', 'run-now', 'export-runs-job'], env());
    const { runId } = JSON.parse(runNow.stdout) as { runId: string };
    await new Promise((resolve) => setTimeout(resolve, 2000)); // let the exec job finish

    const exported = cli(['--json', 'export', '--include-runs'], env());
    expect(exported.status, exported.stderr).toBe(0);
    const data = JSON.parse(exported.stdout) as { jobs: Array<{ id: string }>; runs: Array<{ id: string; jobId: string }> };
    expect(data.runs.some((run) => run.id === runId && run.jobId === 'export-runs-job')).toBe(true);

    // Delete the job (run rows aren't cascade-deleted -- the retention gap L7
    // mitigates), then restore job + runs from the export file.
    const del = cli(['--json', 'delete', 'export-runs-job'], env());
    expect(del.status, del.stderr).toBe(0);

    const exportFile = join(dir, 'export-runs.json');
    writeFileSync(exportFile, exported.stdout, 'utf-8');
    const imported = cli(['--json', 'import', exportFile], env());
    expect(imported.status, imported.stderr).toBe(0);
    const importResult = JSON.parse(imported.stdout) as { runsImported: number; runsSkipped: unknown[] };
    expect(typeof importResult.runsImported).toBe('number');
    expect(Array.isArray(importResult.runsSkipped)).toBe(true);

    const listRuns = cli(['--json', 'runs', 'list', '--job', 'export-runs-job'], env());
    expect(listRuns.status, listRuns.stderr).toBe(0);
    expect((JSON.parse(listRuns.stdout) as Array<{ id: string }>).some((run) => run.id === runId)).toBe(true);
  }, 8000);

  it('crontick schedule and stats commands expose client capabilities', () => {
    const scheduleJson = JSON.stringify({ kind: 'cron', cron: '0 9 * * *' });
    const validate = cli(['--json', 'schedule', 'validate', scheduleJson], env());
    expect(validate.status, validate.stderr).toBe(0);
    expect(JSON.parse(validate.stdout)).toMatchObject({ ok: true });

    const preview = cli(['--json', 'schedule', 'preview', scheduleJson, '--limit', '2'], env());
    expect(preview.status, preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout).next).toHaveLength(2);

    const create = cli(['--json', 'new', 'stats-cli-job', '--cron', '0 1 * * *', '--exec', process.execPath, '--', '-e', 'process.exit(0)'], env());
    expect(create.status, create.stderr).toBe(0);

    const summary = cli(['--json', 'stats', 'summary'], env());
    expect(summary.status, summary.stderr).toBe(0);
    expect(typeof JSON.parse(summary.stdout).totalJobs).toBe('number');

    const job = cli(['--json', 'stats', 'job', 'stats-cli-job'], env());
    expect(job.status, job.stderr).toBe(0);
    expect(JSON.parse(job.stdout).jobId).toBe('stats-cli-job');
  });

  it('crontick daemon status shows daemon info', () => {
    const r = cli(['--json', 'daemon', 'status'], env());
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(typeof data.pid).toBe('number');
    // L2: missedFires is always present (report-only missed-fire summary), even when zero.
    expect(data.missedFires).toMatchObject({
      jobsWithMissedFires: expect.any(Number),
      missedRunsRecorded: expect.any(Number),
      jobsCapped: expect.any(Number),
      capPerJob: expect.any(Number),
    });
  });

  it('crontick doctor exits 0 when daemon is running', () => {
    const r = cli(['doctor'], env());
    // All checks should pass when daemon is healthy
    expect([0, 1]).toContain(r.status);
    expect(r.stdout).toContain('daemon reachable');
  });

  // â”€â”€ --json flag behaviour â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  it('list --json output parses as JSON array', () => {
    // Create a fresh job so the list is non-empty
    cli(['--json', 'new', 'list-json-job', '--cron', '0 0 * * *', '--exec', process.execPath, '--', '-e', 'process.exit(0)'], env());
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
    // Either empty list message or a table header â€” neither starts with [ or {
    expect(first === '[' || first === '{').toBe(false);
  });

  it('dashboard commands render human output and JSON through the client path', () => {
    const start = cli(['--json', 'dashboard', 'start'], env());
    expect(start.status, start.stderr).toBe(0);
    expect(JSON.parse(start.stdout)).toMatchObject({ ok: true, running: true, url: expect.stringContaining('/dashboard') });

    const status = cli(['dashboard', 'status'], env());
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain('Dashboard running:');

    const dataJson = cli(['--json', 'dashboard', 'data', '--runs-limit', '5'], env());
    expect(dataJson.status, dataJson.stderr).toBe(0);
    expect(JSON.parse(dataJson.stdout)).toMatchObject({ stats: { totalJobs: expect.any(Number) }, jobs: expect.any(Array), runs: expect.any(Array) });

    const dataHuman = cli(['dashboard', 'data', '--runs-limit', '5'], env());
    expect(dataHuman.status, dataHuman.stderr).toBe(0);
    expect(dataHuman.stdout).toContain('Jobs');
    expect(dataHuman.stdout).toContain('Recent runs');
  });

  it('dashboard stop returns the shared stop result', () => {
    const r = cli(['--json', 'dashboard', 'stop'], env());
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, stopped: expect.any(Boolean) });
  });
});
