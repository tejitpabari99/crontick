import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { jobJsonSchemaText } from '../../src/schema-json.js';
import { teardownDaemon } from '../helpers/cleanup.js';
import { FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';

const CLI = resolve('dist/cli/index.js');
const DAEMON_SCRIPT = resolve('dist/daemon/index.js');

function cli(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'crontick-cli-'));
  mkdirSync(join(d, 'jobs'), { recursive: true });
  mkdirSync(join(d, 'logs'), { recursive: true });
  return d;
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
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function waitForPortFile(dir: string, maxMs = 30_000, getStderr?: () => string): Promise<number> {
  const portFile = join(dir, 'daemon.port');
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      if (existsSync(portFile)) {
        try {
          const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
          if (!isNaN(port) && port > 0) return resolve(port);
        } catch { /* retry mid-write */ }
      }
      if (++attempts >= Math.ceil(maxMs / 250)) {
        const stderr = getStderr?.() ?? '';
        reject(new Error(`Timed out waiting for daemon${stderr ? `\nDaemon stderr:\n${stderr}` : ''}`));
        return;
      }
      setTimeout(check, 250);
    };
    check();
  });
}

function parseDisplay(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (trimmed === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^[{["]/.test(trimmed)) try { return JSON.parse(trimmed); } catch { /* keep string */ }
  return value;
}

function parseCliObject<T extends Record<string, unknown> = Record<string, unknown>>(stdout: string): T {
  const out: Record<string, unknown> = {};
  for (const line of stdout.trim().split(/\r?\n/)) {
    const idx = line.indexOf(': ');
    if (idx >= 0) out[line.slice(0, idx)] = parseDisplay(line.slice(idx + 2));
  }
  return out as T;
}

function parseCliTable<T extends Record<string, unknown> = Record<string, unknown>>(stdout: string): T[] {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0 || lines[0] === '(no items)') return [];
  const headers = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const values = line.split('\t');
    const row: Record<string, unknown> = {};
    headers.forEach((header, index) => { row[header] = parseDisplay(values[index] ?? ''); });
    return row as T;
  });
}

let uuidCounter = 1;
let fileCounter = 1;
function nextUuid(): string {
  return `00000000-0000-4000-8000-${(uuidCounter++).toString(16).padStart(12, '0')}`;
}

function writeJsonFile(dir: string, name: string, data: unknown): string {
  const file = join(dir, `${fileCounter++}-${name}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  return file;
}

function writeJobFile(dir: string, alias: string, overrides: Record<string, unknown> = {}): { file: string; id: string } {
  const id = typeof overrides.id === 'string' ? overrides.id : nextUuid();
  const job = {
    id,
    alias,
    schedule: { kind: 'cron', cron: '0 0 * * *' },
    action: { kind: 'prompt', prompt: 'process.exit(0)', engine: FAKE_ENGINE_NAME, args: [], reuseSession: false },
    ...overrides,
  };
  return { id, file: writeJsonFile(dir, alias, job) };
}

function expectCleanError(result: ReturnType<typeof cli>, code?: string): void {
  expect(result.status, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(1);
  expect(result.stderr).toContain('error:');
  if (code) expect(result.stderr).toContain(`[${code}]`);
  expect(result.stderr).not.toMatch(/Assertion failed|UV_HANDLE_CLOSING|SyntaxError:/i);
}

// Basic CLI tests (no daemon needed)
describe('CLI binary (dist/cli/index.js)', () => {
  it('version, help, and bare command groups render successfully', () => {
    expect(cli(['--version']).stdout.trim()).toBeTruthy();
    const help = cli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('jobs');
    expect(help.stdout).toContain('runs');
    expect(help.stdout).toContain('share');
    expect(help.stdout.toLowerCase()).not.toContain('auto' + 'start');
    for (const args of [[], ['jobs'], ['runs'], ['share'], ['stats'], ['daemon']]) {
      const result = cli(args);
      expect(result.status, `${args.join(' ')} stderr: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('Usage: crontick');
    }
    const info = cli(['info']);
    expect(info.status, info.stderr).toBe(0);
    expect(info.stdout).toContain('crontick');
  });

  it('usage errors use normalized single-line stderr', () => {
    const unknown = cli(['not-a-real-command']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr.trim()).toBe("error: unknown command 'not-a-real-command'");
    const json = cli(['--json', 'jobs', 'list']);
    expect(json.status).toBe(1);
    expect(json.stderr.trim()).toContain("error: unknown option '--json'");
  });

  it('help reflects new CLI surfaces and removed flags/commands', () => {
    expect(cli(['auto' + 'start', 'status']).status).not.toBe(0);
    // `runs logs` / `runs output` were folded into `runs get`.
    expect(cli(['runs', 'logs']).stderr).toContain("unknown command 'logs'");
    expect(cli(['runs', 'output']).stderr).toContain("unknown command 'output'");
    expect(cli(['runs', 'delete']).stderr).toContain("unknown command 'delete'");
    expect(cli(['config']).stderr).toContain("unknown command 'config'");
    const topHelp = cli(['--help']);
    expect(topHelp.stdout).toContain('doctor');
    expect(topHelp.stdout).toContain('daemon');
    const newHelp = cli(['jobs', 'new', '--help']);
    expect(newHelp.stdout).toContain('--prompt <text>');
    expect(newHelp.stdout).toContain('--file <path>');
    expect(newHelp.stdout).toContain('--alias <alias>');
    expect(newHelp.stdout).toContain('--runner <runner>');
    expect(newHelp.stdout).not.toContain('--engine');
    const updateHelp = cli(['jobs', 'update', '--help']);
    expect(updateHelp.stdout).toContain('--alias <alias>');
    expect(updateHelp.stdout).toContain('--runner <runner>');
    expect(updateHelp.stdout).not.toContain('--engine');
    expect(newHelp.stdout).not.toContain('--exec');
    expect(newHelp.stdout).not.toContain('--script');
    expect(newHelp.stdout).not.toContain('--arg');
    expect(cli(['--help']).stdout).not.toContain('uninstall');
  });

  it('daemon-backed jobs list auto-starts and re-ensures the daemon', async () => {
    const tmp = makeTmpDir();
    try {
      const first = cli(['jobs', 'list'], { CRONTICK_HOME: tmp });
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout.trim()).toBe('(no items)');
      const firstPid = readPidFile(tmp);
      expect(firstPid).toBeGreaterThan(0);
      if (firstPid) {
        try { process.kill(firstPid, 'SIGTERM'); } catch { /* ignore crash races */ }
        await waitForPidExit(firstPid);
      }
      const second = cli(['jobs', 'list'], { CRONTICK_HOME: tmp });
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout.trim()).toBe('(no items)');
      const secondPid = readPidFile(tmp);
      expect(secondPid).toBeGreaterThan(0);
      expect(secondPid).not.toBe(firstPid);
    } finally {
      await teardownDaemon(undefined, tmp);
    }
  }, 30_000);

  it('daemon-free commands do not start the daemon', async () => {
    const tmp = makeTmpDir();
    try {
      expect(cli(['--help'], { CRONTICK_HOME: tmp }).status).toBe(0);
      expect(cli(['--version'], { CRONTICK_HOME: tmp }).status).toBe(0);
      const info = cli(['info'], { CRONTICK_HOME: tmp });
      expect(info.stdout).toContain(join(tmp, 'config.json'));
      expect(info.stdout).toContain('paths');
      expect(info.stdout).toContain('daemon     stopped');
      // The dashboard is always served by the daemon; info surfaces it. With no
      // daemon and no port file, the URL is unresolved and info notes that.
      expect(info.stdout).toContain('dashboard  available once the daemon is running');
      expect(existsSync(join(tmp, 'daemon.port'))).toBe(false);
      expect(existsSync(join(tmp, 'daemon.pid'))).toBe(false);
      expect(existsSync(join(tmp, 'daemon.ensure.lock'))).toBe(false);
    } finally {
      await teardownDaemon(undefined, tmp);
    }
  }, 15_000);

  it('daemon stop and info output render human output only', async () => {
    const tmp = makeTmpDir();
    try {
      expect(cli(['jobs', 'list'], { CRONTICK_HOME: tmp }).status).toBe(0);
      const pid = readPidFile(tmp);
      const stop = cli(['daemon', 'stop'], { CRONTICK_HOME: tmp });
      expect(stop.status, stop.stderr).toBe(0);
      expect(stop.stdout).toContain('mode: graceful');
      expect(stop.stdout).toContain(String(pid));
      const again = cli(['daemon', 'stop'], { CRONTICK_HOME: tmp });
      expect(again.stdout).toContain('mode: already-stopped');

      const info = cli(['info'], { CRONTICK_HOME: tmp });
      expect(info.stdout).toContain(join(tmp, 'config.json'));
      expect(info.stdout).toContain('config');
    } finally {
      await teardownDaemon(undefined, tmp);
    }
  }, 15_000);
});

// End-to-end tests with live daemon
describe('CLI e2e with daemon', () => {
  let dir: string;
  let daemonProc: ChildProcess;

  beforeAll(async () => {
    dir = makeTmpDir();
    writeFakeEngineConfig(dir);
    const stderrChunks: string[] = [];
    daemonProc = spawn(process.execPath, [DAEMON_SCRIPT], { env: { ...process.env, CRONTICK_HOME: dir }, stdio: 'pipe' });
    daemonProc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));
    await waitForPortFile(dir, 30_000, () => stderrChunks.join(''));
  }, 30_000);

  afterAll(async () => {
    await teardownDaemon(daemonProc, dir);
  });

  const env = () => ({ CRONTICK_HOME: dir });

  it('jobs new and update accept --alias/--runner and minute intervals', () => {
    const created = cli(['jobs', 'new', '--alias', 'renamed-flags-job', '--prompt', 'hello', '--runner', 'claude', '--every', '30m'], env());
    expect(created.status, created.stderr).toBe(0);
    expect(parseCliObject(created.stdout)).toMatchObject({ alias: 'renamed-flags-job', schedule: { kind: 'interval', everySec: 1800 } });
    expect(parseCliObject(created.stdout).action).toMatchObject({ engine: 'claude' });

    const updated = cli(['jobs', 'update', 'renamed-flags-job', '--alias', 'renamed-flags-job-updated', '--prompt', 'hello', '--runner', FAKE_ENGINE_NAME, '--every', '2h'], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(parseCliObject(updated.stdout)).toMatchObject({ alias: 'renamed-flags-job-updated', schedule: { kind: 'interval', everySec: 7200 } });
    expect(parseCliObject(updated.stdout).action).toMatchObject({ engine: FAKE_ENGINE_NAME });

    const numeric = cli(['jobs', 'update', 'renamed-flags-job-updated', '--every', '300'], env());
    expect(numeric.status, numeric.stderr).toBe(0);
    expect(parseCliObject(numeric.stdout).schedule).toEqual({ kind: 'interval', everySec: 300 });

    const invalid = cli(['jobs', 'update', 'renamed-flags-job-updated', '--every', '30x'], env());
    expectCleanError(invalid);
    expect(invalid.stderr).toContain('Invalid interval: 30x');
  });

  it('rejects removed --engine flags instead of forwarding them to the runner', () => {
    for (const command of [
      ['jobs', 'new', '--alias', 'old-flags-rejected', '--prompt', 'hello', '--every', '300'],
      ['jobs', 'update', 'nonexistent-job', '--prompt', 'hello'],
    ]) {
      for (const oldFlag of ['--engine', '--engine=claude']) {
        for (const separator of [[], ['--']]) {
          const result = cli([...command, ...separator, oldFlag, ...(oldFlag.includes('=') ? [] : ['old'])], env());
          expectCleanError(result);
          expect(result.stderr).toContain(`unknown option '${oldFlag.split('=')[0]}'`);
        }
      }
    }
  });

  it('jobs new --file creates a prompt job; duplicate aliases require --force', () => {
    const { file, id } = writeJobFile(dir, 'e2e-job');
    const created = cli(['jobs', 'new', '--file', file], env());
    expect(created.status, created.stderr).toBe(0);
    expect(parseCliObject(created.stdout)).toMatchObject({ id, alias: 'e2e-job' });
    expect(parseCliObject(created.stdout).action).toMatchObject({ kind: 'prompt', prompt: 'process.exit(0)', engine: FAKE_ENGINE_NAME });
    expect(readFileSync(join(dir, 'jobs', `${id}.schema.json`), 'utf-8')).toBe(jobJsonSchemaText());

    const original = writeJobFile(dir, 'duplicate-cli-job', {
      schedule: { kind: 'interval', everySec: 60 },
      description: 'original cli definition',
      action: { kind: 'prompt', prompt: 'process.exit(0)', engine: FAKE_ENGINE_NAME, args: [], reuseSession: false },
    }).file;
    expect(cli(['jobs', 'new', '--file', original], env()).status).toBe(0);
    const replacement = writeJobFile(dir, 'duplicate-cli-job', {
      schedule: { kind: 'cron', cron: '15 6 * * *' },
      description: 'replacement cli definition',
      action: { kind: 'prompt', prompt: 'process.exit(1)', engine: FAKE_ENGINE_NAME, args: [], reuseSession: false },
    }).file;
    expectCleanError(cli(['jobs', 'new', '--file', replacement], env()), 'JOB_ALREADY_EXISTS');
    expect(parseCliObject(cli(['jobs', 'get', 'duplicate-cli-job'], env()).stdout)).toMatchObject({ description: 'original cli definition' });
    const forced = cli(['jobs', 'new', '--force', '--file', replacement], env());
    expect(forced.status, forced.stderr).toBe(0);
    expect(parseCliObject(forced.stdout)).toMatchObject({ description: 'replacement cli definition', schedule: { kind: 'cron', cron: '15 6 * * *' } });
  });

  it('jobs new creates prompt jobs with aliases, defaults, prompt files, passthrough args, and session notices', () => {
    let r = cli(['jobs', 'new', '--alias', 'prompt-cli-job', '--cron', '0 9 * * *', '--prompt', 'Summarize'], env());
    expect(r.status, r.stderr).toBe(0);
    expect(parseCliObject(r.stdout).action).toMatchObject({ kind: 'prompt', prompt: 'Summarize', engine: 'claude', args: [], reuseSession: false });

    r = cli(['jobs', 'new', '--alias', 'prompt-leading-dash-cli-job', '--cron', '0 9 * * *', '--prompt=- summarize'], env());
    expect(r.status, r.stderr).toBe(0);
    expect(parseCliObject(r.stdout).action).toMatchObject({ prompt: '- summarize' });

    const promptPath = join(dir, 'prompt.txt');
    writeFileSync(promptPath, 'Prompt from file', 'utf-8');
    r = cli(['jobs', 'new', '--alias', 'prompt-file-cli-job', '--cron', '0 10 * * *', '--prompt-file', promptPath, '--runner', 'agency', '--reuse-session', '--', '--silent', '--flag', 'one'], env());
    expect(r.status, r.stderr).toBe(0);
    expect(parseCliObject(r.stdout).action).toMatchObject({ prompt: 'Prompt from file', engine: 'agency', args: ['--silent', '--flag', 'one'], reuseSession: true });

    r = cli(['jobs', 'new', '--alias', 'prompt-session-cli-job', '--cron', '0 11 * * *', '--prompt', 'hello', '--session-id', 'sess-12345678', '--reuse-session'], env());
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain('reuseSession was ignored');
    expect(parseCliObject(r.stdout).action).toMatchObject({ sessionId: 'sess-12345678', reuseSession: false });
  });

  it('jobs new and update forward unknown long flags and values in argv order', () => {
    const created = cli([
      'jobs', 'new', '--alias', 'unknown-flags-job', '--every', '300', '--prompt', 'hello',
      '--allow-all', '--permission-mode', 'acceptEdits', '--max-budget-usd=2',
    ], env());
    expect(created.status, created.stderr).toBe(0);
    expect(parseCliObject(created.stdout).action).toMatchObject({
      args: ['--allow-all', '--permission-mode', 'acceptEdits', '--max-budget-usd=2'],
    });

    const updated = cli([
      'jobs', 'update', 'unknown-flags-job', '--prompt', 'hello again',
      '--allowedTools', 'Read,Edit', '--dangerously-skip-permissions',
    ], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(parseCliObject(updated.stdout).action).toMatchObject({
      args: ['--allowedTools', 'Read,Edit', '--dangerously-skip-permissions'],
    });

    const afterSeparator = cli([
      'jobs', 'update', 'unknown-flags-job', '--prompt', 'hello again', '--',
      '--permission-mode', 'bypassPermissions', '--max-budget-usd=3',
    ], env());
    expect(afterSeparator.status, afterSeparator.stderr).toBe(0);
    expect(parseCliObject(afterSeparator.stdout).action).toMatchObject({
      args: ['--permission-mode', 'bypassPermissions', '--max-budget-usd=3'],
    });

    const interleaved = cli([
      'jobs', 'update', 'unknown-flags-job', '--prompt', 'hello again', '--',
      'literal', '--allow-all', '--permission-mode', 'acceptEdits', 'tail',
    ], env());
    expect(interleaved.status, interleaved.stderr).toBe(0);
    expect(parseCliObject(interleaved.stdout).action).toMatchObject({
      args: ['literal', '--allow-all', '--permission-mode', 'acceptEdits', 'tail'],
    });
  });

  it('rejects reserved unknown long flags on create and update', () => {
    const created = cli(['jobs', 'new', '--alias', 'reserved-unknown-job', '--every', '300', '--prompt', 'hi', '--settings', '{}'], env());
    expectCleanError(created, 'VALIDATION_ERROR');
    expect(created.stderr).toContain('crontick-managed prompt/session flag: --settings');

    const valid = cli(['jobs', 'new', '--alias', 'reserved-unknown-job', '--every', '300', '--prompt', 'hi'], env());
    expect(valid.status, valid.stderr).toBe(0);
    const updated = cli(['jobs', 'update', 'reserved-unknown-job', '--prompt', 'hi', '--output-format=json'], env());
    expectCleanError(updated, 'VALIDATION_ERROR');
    expect(updated.stderr).toContain('crontick-managed prompt/session flag: --output-format=json');
  });

  it('requires overlap skip for reuse-session and reports overlapping fires as skipped', () => {
    const base = ['jobs', 'new', '--alias', 'cli-skipped-run-job', '--cron', '0 0 * * *', '--prompt', 'setTimeout(() => process.exit(0), 10000)', '--runner', FAKE_ENGINE_NAME, '--reuse-session'];
    for (const policy of ['queue', 'cancel-previous']) {
      const rejected = cli([...base, '--overlap', policy], env());
      expectCleanError(rejected, 'VALIDATION_ERROR');
    }
    const created = cli(base, env());
    expect(created.status, created.stderr).toBe(0);
    expect(parseCliObject(created.stdout)).toMatchObject({ overlap: 'skip', action: expect.objectContaining({ reuseSession: true }) });
    const invalidUpdate = cli(['jobs', 'update', 'cli-skipped-run-job', '--overlap', 'queue'], env());
    expectCleanError(invalidUpdate, 'VALIDATION_ERROR');
    expect(parseCliObject(cli(['jobs', 'get', 'cli-skipped-run-job'], env()).stdout).overlap).toBe('skip');

    const first = cli(['jobs', 'run-now', 'cli-skipped-run-job'], env());
    expect(first.status, first.stderr).toBe(0);
    const firstId = parseCliObject(first.stdout).runId;
    expect(typeof firstId).toBe('string');
    const second = cli(['jobs', 'run-now', 'cli-skipped-run-job'], env());
    expect(second.status, second.stderr).toBe(0);
    const secondId = parseCliObject(second.stdout).runId;
    const skipped = cli(['runs', 'list', '--job', 'cli-skipped-run-job', '--status', 'skipped', '--json'], env());
    expect(skipped.status, skipped.stderr).toBe(0);
    expect(JSON.parse(skipped.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ id: secondId, status: 'skipped' })]));
    const summary = parseCliObject(cli(['stats', 'summary'], env()).stdout);
    const jobStats = parseCliObject(cli(['stats', 'job', 'cli-skipped-run-job'], env()).stdout);
    expect(summary).toMatchObject({ skipped: expect.any(Number), canceled: expect.any(Number) });
    expect(jobStats).toMatchObject({ skipped: 1, canceled: expect.any(Number) });
    expect(Number(summary.skipped)).toBeGreaterThanOrEqual(1);

    const cancel = cli(['runs', 'cancel', String(firstId)], env());
    expect(cancel.status, cancel.stderr).toBe(0);
  }, 30_000);

  it('jobs new reports validation errors for missing action, raw prompt/session collisions, oversize prompt, and --file conflicts', () => {
    const missing = cli(['jobs', 'new', '--alias', 'missing-action-job', '--cron', '0 0 * * *'], env());
    expectCleanError(missing, 'MISSING_ARG');
    expect(missing.stderr).toContain('Provide --prompt or --prompt-file');
    const collision = cli(['jobs', 'new', '--alias', 'prompt-reserved-arg-job', '--cron', '0 11 * * *', '--prompt', 'hello', '--', '--session-id=sess-12345678'], env());
    expectCleanError(collision, 'VALIDATION_ERROR');
    expect(collision.stderr).toContain('prompt/session flag');
    const tooLarge = cli(['jobs', 'new', '--alias', 'prompt-argv-limit-job', '--cron', '0 11 * * *', `--prompt=${'x'.repeat(31_000)}`], env());
    expectCleanError(tooLarge, 'VALIDATION_ERROR');
    expect(tooLarge.stderr).toContain('Windows-safe command line limit');
    const jobFile = writeJobFile(dir, 'file-conflict-job', { action: { kind: 'prompt', prompt: 'x' } }).file;
    const fileConflict = cli(['jobs', 'new', '--file', jobFile, '--prompt', 'x'], env());
    expectCleanError(fileConflict, 'VALIDATION_ERROR');
    expect(fileConflict.stderr).toContain('--file is mutually exclusive');
  });

  it('jobs list/get return human table/object output', () => {
    const list = cli(['jobs', 'list'], env());
    expect(list.status, list.stderr).toBe(0);
    expect(parseCliTable(list.stdout).some((j) => j.alias === 'e2e-job')).toBe(true);
    const get = cli(['jobs', 'get', 'e2e-job'], env());
    expect(get.status, get.stderr).toBe(0);
    expect(parseCliObject(get.stdout).alias).toBe('e2e-job');
  });

  it('job create/get/list/update responses redact secret env values while preserving benign ones', () => {
    const alias = 'cli-redaction-job';
    const createSecret = `sk-proj-${'V'.repeat(28)}`;
    const updateSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const createFile = writeJobFile(dir, alias, { action: { kind: 'prompt', prompt: 'process.exit(0)', engine: FAKE_ENGINE_NAME, args: [], reuseSession: false, env: { OPENAI_API_KEY: createSecret, NON_SECRET: 'https://example.test/job-visible' } } }).file;
    let result = cli(['jobs', 'new', '--file', createFile], env());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(createSecret);
    expect(parseCliObject(result.stdout).action).toMatchObject({ env: { OPENAI_API_KEY: '[REDACTED]', NON_SECRET: 'https://example.test/job-visible' } });
    result = cli(['jobs', 'get', alias], env());
    expect(result.stdout).not.toContain(createSecret);
    result = cli(['jobs', 'list'], env());
    expect(result.stdout).not.toContain(createSecret);
    expect(parseCliTable(result.stdout)).toContainEqual(expect.objectContaining({ alias, action: expect.objectContaining({ env: expect.objectContaining({ OPENAI_API_KEY: '[REDACTED]' }) }) }));
    const patchFile = writeJsonFile(dir, 'cli-redaction-job-update', { action: { kind: 'prompt', prompt: 'process.exit(0)', env: { AWS_SECRET_ACCESS_KEY: updateSecret, NO_PASSWORD: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLl1Mm2Nn' } } });
    result = cli(['jobs', 'update', alias, '--file', patchFile], env());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(updateSecret);
    expect(parseCliObject(result.stdout).action).toMatchObject({ env: { AWS_SECRET_ACCESS_KEY: '[REDACTED]', NO_PASSWORD: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLl1Mm2Nn' } });
    result = cli(['jobs', 'update', alias, '--disable'], env());
    expect(parseCliObject(result.stdout)).toMatchObject({ alias, enabled: false });
    result = cli(['jobs', 'update', alias, '--enable'], env());
    expect(parseCliObject(result.stdout)).toMatchObject({ alias, enabled: true });
  });

  it('jobs update changes metadata, overlap, enablement, timezone, and preserves omitted fields', () => {
    const { file } = writeJobFile(dir, 'merge-check-job', { schedule: { kind: 'cron', cron: '0 9 * * *' }, action: { kind: 'prompt', prompt: 'hi', args: [], reuseSession: false }, overlap: 'queue', retry: { max: 2, backoffSec: 30 } });
    expect(cli(['jobs', 'new', '--file', file], env()).status).toBe(0);
    let updated = cli(['jobs', 'update', 'merge-check-job', '--desc', 'merged'], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(parseCliObject(updated.stdout)).toMatchObject({ description: 'merged', overlap: 'queue', retry: { max: 2, backoffSec: 30 } });
    updated = cli(['jobs', 'update', 'merge-check-job', '--overlap', 'skip', '--disable'], env());
    expect(parseCliObject(updated.stdout)).toMatchObject({ overlap: 'skip', enabled: false });
    updated = cli(['jobs', 'update', 'merge-check-job', '--overlap', 'cancel-previous', '--enable'], env());
    expect(parseCliObject(updated.stdout)).toMatchObject({ overlap: 'cancel-previous', enabled: true });
    updated = cli(['jobs', 'update', 'merge-check-job', '--cron', '0 10 * * *'], env());
    expect(parseCliObject(updated.stdout).schedule).toEqual({ kind: 'cron', cron: '0 10 * * *' });
    // --tz was removed and must not leak into the engine args as a passthrough flag.
    const removedTz = cli(['jobs', 'update', 'merge-check-job', '--cron', '0 10 * * *', '--tz', 'UTC'], env());
    expect(removedTz.status).toBe(1);
    expect(removedTz.stderr).toContain("unknown option '--tz'");
    const invalid = cli(['jobs', 'update', 'merge-check-job', '--enable', '--disable'], env());
    expectCleanError(invalid, 'VALIDATION_ERROR');
  });

  it('jobs update --file preserves and replaces action/retry fields through the core patch path', () => {
    const { file } = writeJobFile(dir, 'file-patch-job', { action: { kind: 'prompt', prompt: 'hi', args: ['a', 'b'], reuseSession: false } });
    expect(cli(['jobs', 'new', '--file', file], env()).status).toBe(0);
    const envFilePath = join(dir, 'file-prompt-args.env');
    writeFileSync(envFilePath, 'FOO=bar\n', 'utf-8');
    let patchFile = writeJsonFile(dir, 'file-prompt-args-patch', { action: { kind: 'prompt', envFile: envFilePath } });
    let updated = cli(['jobs', 'update', 'file-patch-job', '--file', patchFile], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(parseCliObject(updated.stdout).action).toMatchObject({ kind: 'prompt', prompt: 'hi', args: ['a', 'b'], envFile: envFilePath });
    patchFile = writeJsonFile(dir, 'file-action-engine-patch', { action: { kind: 'prompt', engine: 'agency' } });
    updated = cli(['jobs', 'update', 'file-patch-job', '--file', patchFile], env());
    expect(parseCliObject(updated.stdout).action).toMatchObject({ kind: 'prompt', prompt: 'hi', engine: 'agency' });
    patchFile = writeJsonFile(dir, 'file-retry-seed-patch', { retry: { max: 1, backoffSec: 90 } });
    updated = cli(['jobs', 'update', 'file-patch-job', '--file', patchFile], env());
    expect(parseCliObject(updated.stdout).retry).toEqual({ max: 1, backoffSec: 90 });
    patchFile = writeJsonFile(dir, 'file-retry-preserve-patch', { retry: { max: 3 } });
    updated = cli(['jobs', 'update', 'file-patch-job', '--file', patchFile], env());
    expect(parseCliObject(updated.stdout).retry).toEqual({ max: 3, backoffSec: 90 });
  });

  it('jobs update --file preserves prompt args/reuseSession/engine when only prompt text changes', () => {
    const created = cli(['jobs', 'new', '--alias', 'file-prompt-preserve-job', '--cron', '0 9 * * *', '--prompt', 'old', '--runner', 'agency', '--reuse-session', '--', '--flag'], env());
    expect(created.status, created.stderr).toBe(0);
    const patchFile = writeJsonFile(dir, 'file-prompt-preserve-patch', { action: { kind: 'prompt', prompt: 'new' } });
    const updated = cli(['jobs', 'update', 'file-prompt-preserve-job', '--file', patchFile], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(parseCliObject(updated.stdout).action).toMatchObject({ kind: 'prompt', prompt: 'new', args: ['--flag'], reuseSession: true, engine: 'agency' });
  });

  it('jobs run-now triggers a run; runs commands inspect, filter, log, cancel, and delete it', async () => {
    const r = cli(['jobs', 'run-now', 'e2e-job'], env());
    expect(r.status, r.stderr).toBe(0);
    const { runId } = parseCliObject<{ runId: string }>(r.stdout);
    expect(typeof runId).toBe('string');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const getRun = cli(['runs', 'get', runId], env());
    expect(getRun.status, getRun.stderr).toBe(0);
    const run = parseCliObject(getRun.stdout);
    expect(run['Run ID']).toBe(runId);
    expect(run).toHaveProperty('Command');
    expect(getRun.stdout.match(/^Status:/gm)).toHaveLength(1);
    expect(getRun.stdout).toMatch(/^Log file: .*\.log/m);
    expect(getRun.stdout).toMatch(/^Started: \d{4}-\d\d-\d\dT/m);
    const rawRun = JSON.parse(cli(['runs', 'get', runId, '--json'], env()).stdout) as { run: { id: string; logFile: string | null; startedAt: number }; output: { runId: string } };
    expect(rawRun.run.id).toBe(runId);
    expect(typeof rawRun.run.startedAt).toBe('number');
    expect(rawRun.output.runId).toBe(runId);
    const listRuns = cli(['runs', 'list', '--job', 'e2e-job', '--limit', '5', '--status', 'success', '--json'], env());
    expect(listRuns.status, listRuns.stderr).toBe(0);
    const runs = JSON.parse(listRuns.stdout) as Array<{ id: string; status: string; startedAt: number }>;
    expect(typeof runs[0]!.startedAt).toBe('number'); // --json keeps raw epoch milliseconds
    const humanRuns = cli(['runs', 'list', '--job', 'e2e-job', '--limit', '5', '--status', 'success'], env());
    expect(humanRuns.status, humanRuns.stderr).toBe(0);
    expect(humanRuns.stdout).toMatch(/^RUN\s+JOB\s+STATUS\s+STARTED\s+ENDED\s+DURATION\s+EXIT\s+ERROR/);
    expect(humanRuns.stdout).toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d/);
    expect(humanRuns.stdout).not.toMatch(/\b1[6-9]\d{11}\b/);
    expect(runs.every((listed) => listed.status === 'success')).toBe(true);
    expect(runs.some((listed) => listed.id === runId)).toBe(true);
    // Invalid --limit (non-positive) is rejected as a clean validation error, not a crash.
    const badLimit = cli(['runs', 'list', '--limit', '0'], env());
    expectCleanError(badLimit, 'VALIDATION_ERROR');
    expect(parseCliObject(cli(['runs', 'cancel', runId], env()).stdout)).toMatchObject({ ok: true });
  }, 10_000);

  describe('daemon-backed errors exit cleanly (no libuv assertion crash)', () => {
    const NONEXISTENT_ID = 'does-not-exist-regression-id';
    it('jobs get/delete/update/run-now and runs cancel normalize daemon errors', () => {
      expectCleanError(cli(['jobs', 'get', NONEXISTENT_ID], env()), 'JOB_NOT_FOUND');
      expectCleanError(cli(['jobs', 'delete', NONEXISTENT_ID], env()), 'JOB_NOT_FOUND');
      expectCleanError(cli(['jobs', 'update', NONEXISTENT_ID, '--disable'], env()), 'JOB_NOT_FOUND');
      expectCleanError(cli(['jobs', 'run-now', NONEXISTENT_ID], env()), 'JOB_NOT_FOUND');
      expectCleanError(cli(['runs', 'cancel', NONEXISTENT_ID], env()), 'NOT_FOUND');
    });
  });

  it('jobs delete removes jobs and `all` requires --force', () => {
    const del = cli(['jobs', 'delete', 'e2e-job'], env());
    expect(del.status, del.stderr).toBe(0);
    expectCleanError(cli(['jobs', 'get', 'e2e-job'], env()), 'JOB_NOT_FOUND');
    const withoutForce = cli(['jobs', 'delete', 'all'], env());
    expectCleanError(withoutForce, 'VALIDATION_ERROR');
    expect(withoutForce.stderr).toContain('requires force:true');
    const withForce = cli(['jobs', 'delete', 'all', '--force'], env());
    expect(withForce.status, withForce.stderr).toBe(0);
    expect(parseCliObject(withForce.stdout)).toMatchObject({ ok: true, deleted: expect.any(Number) });
  });

  it('share export/import: schema 1 jobs only, --out .json suffix, --only-jobs, BOM-prefixed import with new ids', async () => {
    const { file, id } = writeJobFile(dir, 'import-export-job');
    expect(cli(['jobs', 'new', '--file', file], env()).status).toBe(0);
    const runNow = cli(['jobs', 'run-now', 'import-export-job'], env());
    expect(runNow.status, runNow.stderr).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const exported = cli(['share', 'export'], env());
    expect(exported.status, exported.stderr).toBe(0);
    const data = JSON.parse(exported.stdout) as { schema: number; exportedAt: string; crontickVersion: string; jobs: Array<{ id?: string; alias: string }>; runs?: unknown[] };
    expect(data).toMatchObject({ schema: 1, exportedAt: expect.any(String), crontickVersion: expect.any(String) });
    expect(data.jobs.some((job) => job.alias === 'import-export-job')).toBe(true);
    expect(data.jobs.every((job) => job.id === undefined)).toBe(true);
    expect(data.runs).toBeUndefined();

    // --out: ".json" appended unless already present (case-insensitive); absolute path printed.
    const plain = join(dir, 'export-out');
    const toFile = cli(['share', 'export', '--out', plain], env());
    expect(toFile.status, toFile.stderr).toBe(0);
    expect(toFile.stdout.trim()).toBe(`Exported ${data.jobs.length} job(s) to ${plain}.json`);
    expect(JSON.parse(readFileSync(`${plain}.json`, 'utf-8')).jobs).toEqual(expect.any(Array));
    const txt = cli(['share', 'export', '--out', join(dir, 'try_me.txt')], env());
    expect(txt.stdout.trim()).toBe(`Exported ${data.jobs.length} job(s) to ${join(dir, 'try_me.txt')}.json`);
    const upper = cli(['share', 'export', '--out', join(dir, 'KEEP.JSON')], env());
    expect(upper.stdout.trim()).toBe(`Exported ${data.jobs.length} job(s) to ${join(dir, 'KEEP.JSON')}`);

    // --only-jobs filters by id or alias; a miss reports every unknown entry and writes nothing.
    const only = cli(['share', 'export', '--only-jobs', `${id},import-export-job`], env());
    expect((JSON.parse(only.stdout) as { jobs: unknown[] }).jobs).toHaveLength(1);
    const outMissing = join(dir, 'never-written');
    const missing = cli(['share', 'export', '--only-jobs', 'import-export-job,ghost-1,ghost-2', '--out', outMissing], env());
    expectCleanError(missing, 'JOB_NOT_FOUND');
    expect(missing.stderr).toContain('ghost-1, ghost-2');
    expect(existsSync(`${outMissing}.json`)).toBe(false);
    expect(cli(['share', 'export', '--include-runs'], env()).stderr).toContain("unknown option '--include-runs'");

    // Import: a collision with the live job is suffixed, ids are new, runs are never imported.
    const importFile = join(dir, 'import-bom.json');
    writeFileSync(importFile, `\uFEFF${exported.stdout}`, 'utf-8');
    const jobsBefore = parseCliTable(cli(['jobs', 'list'], env()).stdout).length;
    const imported = cli(['share', 'import', importFile], env());
    expect(imported.status, imported.stderr).toBe(0);
    expect(parseCliObject(imported.stdout).imported).toBe(data.jobs.length);
    expect(imported.stdout).toContain('"renamedFrom":"import-export-job"');
    expect(parseCliTable(cli(['jobs', 'list'], env()).stdout).length).toBe(jobsBefore + data.jobs.length);
    expect(cli(['jobs', 'get', 'import-export-job-2'], env()).status).toBe(0);
    expect(cli(['jobs', 'get', 'import-export-job'], env()).stdout).toContain(id);
    const runsOfCopy = cli(['runs', 'list', '--job', 'import-export-job-2', '--json'], env());
    expect(JSON.parse(runsOfCopy.stdout)).toEqual([]);
  }, 15_000);

  it('share import rejects bare arrays, a missing or wrong schema and bad rows, importing nothing', () => {
    const count = () => parseCliTable(cli(['jobs', 'list'], env()).stdout).length;
    const before = count();
    const job = { alias: 'should-not-import', schedule: { kind: 'cron', cron: '0 12 * * *' }, action: { kind: 'prompt', prompt: 'x' } };
    const bad = (name: string, body: unknown): string => {
      const f = join(dir, `${name}.json`);
      writeFileSync(f, JSON.stringify(body), 'utf-8');
      return f;
    };
    let result = cli(['share', 'import', bad('bare-array', [job])], env());
    expectCleanError(result, 'VALIDATION_ERROR');
    expect(result.stderr).toContain('bare array');
    result = cli(['share', 'import', bad('no-schema', { jobs: [job] })], env());
    expectCleanError(result, 'VALIDATION_ERROR');
    expect(result.stderr).toContain('schema');
    result = cli(['share', 'import', bad('schema-2', { schema: 2, jobs: [job] })], env());
    expectCleanError(result, 'VALIDATION_ERROR');
    result = cli(['share', 'import', bad('bad-row', { schema: 1, jobs: [job, { ...job, alias: 'second', schedule: { kind: 'cron' } }] })], env());
    expectCleanError(result, 'VALIDATION_ERROR');
    expect(result.stderr).toContain('jobs.1.schedule');
    expect(count()).toBe(before);
    const missingDir = cli(['share', 'import', bad('bad-cwd', { schema: 1, jobs: [{ ...job, action: { kind: 'prompt', prompt: 'x', cwd: '/definitely/not/here' } }, { ...job, alias: 'good-one' }] })], env());
    expect(missingDir.status, missingDir.stderr).toBe(0);
    expect(parseCliObject(missingDir.stdout).imported).toBe(1);
    expect(missingDir.stdout).toContain('INVALID_CWD');
  });

  it('share import and jobs new/update --file report JSON parse errors without mutation', () => {
    const badImport = join(dir, 'import-bad.json');
    writeFileSync(badImport, '{ nope', 'utf-8');
    let result = cli(['share', 'import', badImport], env());
    expectCleanError(result, 'VALIDATION_ERROR');
    expect(result.stderr).toContain(badImport);
    expect(result.stderr).toContain('expected a crontick export object');
    const eofImport = join(dir, 'import-eof.json');
    const eofContents = '{ "schema": 1, "jobs": [ ';
    writeFileSync(eofImport, eofContents, 'utf-8');
    result = cli(['share', 'import', eofImport], env());
    expectCleanError(result, 'VALIDATION_ERROR');
    expect(result.stderr).toContain('Unexpected end of JSON input');
    expect(result.stderr).toContain(`position ${eofContents.length}`);

    const createJob = { id: nextUuid(), alias: 'cli-file-create-job', schedule: { kind: 'cron', cron: '0 12 * * *' }, action: { kind: 'prompt', prompt: 'bom-create', args: [], reuseSession: false } };
    const createFile = join(dir, 'new-file-bom.json');
    writeFileSync(createFile, `\uFEFF${JSON.stringify(createJob, null, 2)}`, 'utf-8');
    expect(cli(['jobs', 'new', '--file', createFile], env()).status).toBe(0);
    const beforeCount = parseCliTable(cli(['jobs', 'list'], env()).stdout).length;
    const badCreateFile = join(dir, 'new-file-bad.json');
    writeFileSync(badCreateFile, '{ nope', 'utf-8');
    result = cli(['jobs', 'new', '--file', badCreateFile], env());
    expectCleanError(result, 'VALIDATION_ERROR');
    expect(result.stderr).toContain('expected a JSON object matching the crontick job schema');
    expect(parseCliTable(cli(['jobs', 'list'], env()).stdout).length).toBe(beforeCount);
    const patchFile = join(dir, 'update-file-bom.json');
    writeFileSync(patchFile, `\uFEFF${JSON.stringify({ action: { kind: 'prompt', prompt: 'bom-update' } })}`, 'utf-8');
    expect(cli(['jobs', 'update', 'cli-file-create-job', '--file', patchFile], env()).status).toBe(0);
    const beforeBad = parseCliObject(cli(['jobs', 'get', 'cli-file-create-job'], env()).stdout);
    const badPatchFile = join(dir, 'update-file-bad.json');
    writeFileSync(badPatchFile, '{ nope', 'utf-8');
    result = cli(['jobs', 'update', 'cli-file-create-job', '--file', badPatchFile], env());
    expectCleanError(result, 'VALIDATION_ERROR');
    expect(result.stderr).toContain('expected a JSON object matching the crontick job patch schema');
    expect(parseCliObject(cli(['jobs', 'get', 'cli-file-create-job'], env()).stdout)).toEqual(beforeBad);
  });

  it('jobs schedule and stats expose client capabilities; removed schedule/dashboard data commands fail cleanly', () => {
    const { file, id } = writeJobFile(dir, 'stats-cli-job', { schedule: { kind: 'cron', cron: '0 1 * * *' } });
    expect(cli(['jobs', 'new', '--file', file], env()).status).toBe(0);
    const schedule = cli(['jobs', 'schedule', 'stats-cli-job', '-n', '2'], env());
    expect(schedule.status, schedule.stderr).toBe(0);
    expect((parseCliObject(schedule.stdout) as { next: unknown[] }).next).toHaveLength(2);
    const summary = cli(['stats', 'summary'], env());
    expect(summary.status, summary.stderr).toBe(0);
    expect(typeof parseCliObject(summary.stdout).totalJobs).toBe('number');
    const job = cli(['stats', 'job', 'stats-cli-job'], env());
    expect(job.status, job.stderr).toBe(0);
    expect(parseCliObject(job.stdout).jobId).toBe(id);
    expectCleanError(cli(['schedule', 'validate', '{"kind":"cron","cron":"0 9 * * *"}'], env()));
  });

  it('info default output has no command list and info subcommands are gone', async () => {
    const doctor = cli(['doctor'], env());
    expect([0, 1]).toContain(doctor.status);
    expect(doctor.stdout).toContain('daemon reachable');

    const info = cli(['info'], env());
    expect(info.status, info.stderr).toBe(0);
    expect(info.stdout).toContain('daemon');
    expect(info.stdout).toContain('config');
    expect(info.stdout).toContain('paths');
    expect(info.stdout).toMatch(/dashboard\s+http:\/\/127\.0\.0\.1:\d+\/dashboard/);

    // `info` no longer prints a commands list.
    expect(info.stdout).not.toMatch(/^commands\b/m);
    expect(info.stdout).not.toContain('daemon start');
    expect(cli(['info', '--help'], env()).stdout).not.toMatch(/daemon\/doctor commands/);

    const daemonHelp = cli(['daemon', '--help'], env());
    expect(daemonHelp.status, daemonHelp.stderr).toBe(0);
    for (const sub of ['start', 'stop', 'status', 'restart', 'reload']) expect(daemonHelp.stdout).toContain(sub);

    const daemonBare = cli(['daemon'], env());
    expect(daemonBare.status, daemonBare.stderr).toBe(0);
    expect(daemonBare.stdout).toContain('Usage: crontick daemon');

    // `info daemon` / `info doctor` are not commands.
    for (const unknownCommand of [['info', 'daemon'], ['info', 'daemon', 'stop'], ['info', 'doctor']]) {
      const result = cli(unknownCommand, env());
      expect(result.status, unknownCommand.join(' ')).toBe(1);
      expect(result.stderr).toContain('unknown command');
    }
  }, 8000);

  it('jobs delete all requires --force and deletes all when confirmed', async () => {
    for (const alias of ['bulk-delete-a', 'bulk-delete-b']) {
      const { file } = writeJobFile(dir, alias);
      expect(cli(['jobs', 'new', '--file', file], env()).status).toBe(0);
    }

    const missingForce = cli(['jobs', 'delete', 'all'], env());
    expectCleanError(missingForce, 'VALIDATION_ERROR');
    // Force validation now originates in the core client (thin-shim rule), so
    // the CLI surfaces the core's message.
    expect(missingForce.stderr).toContain('requires force:true');

    const deleted = cli(['jobs', 'delete', 'all', '--force'], env());
    expect(deleted.status, deleted.stderr).toBe(0);
    expect(parseCliObject(deleted.stdout)).toMatchObject({ ok: true, deleted: expect.any(Number) });

    const jobs = parseCliTable(cli(['jobs', 'list'], env()).stdout);
    const aliases = new Set(jobs.map((row) => String(row.alias ?? '')));
    expect(aliases.has('bulk-delete-a')).toBe(false);
    expect(aliases.has('bulk-delete-b')).toBe(false);
  }, 8000);

  it('jobs delete <alias> deletes one job', () => {
    const { file } = writeJobFile(dir, 'single-delete-job');
    expect(cli(['jobs', 'new', '--file', file], env()).status).toBe(0);
    const deleted = cli(['jobs', 'delete', 'single-delete-job'], env());
    expect(deleted.status, deleted.stderr).toBe(0);
    expect(parseCliObject(deleted.stdout)).toMatchObject({ ok: true });
    expect(parseCliTable(cli(['jobs', 'list'], env()).stdout).some((row) => row.alias === 'single-delete-job')).toBe(false);
  });
});
