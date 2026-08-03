import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { jobJsonSchemaText } from '../../src/schema-json.js';

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

function stopDaemonInHome(dir: string): void {
  const pidFile = join(dir, 'daemon.pid');
  if (!existsSync(pidFile)) return;
  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  if (!isNaN(pid)) try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
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
    action: { kind: 'exec', command: process.execPath, args: ['-e', 'process.exit(0)'] },
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
    const logsHelp = cli(['runs', 'logs', '--help']);
    expect(logsHelp.stdout).toContain('[source]');
    expect(logsHelp.stdout).toContain('--tail <n>');
    expect(logsHelp.stdout).not.toContain('--lines');
    expect(logsHelp.stdout).not.toContain('--follow');
    const newHelp = cli(['jobs', 'new', '--help']);
    expect(newHelp.stdout).toContain('--prompt <text>');
    expect(newHelp.stdout).toContain('--file <path>');
    expect(newHelp.stdout).toContain('--alias <alias>');
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
      expect(cli(['config'], { CRONTICK_HOME: tmp }).stdout).toContain(join(tmp, 'config.json'));
      const info = cli(['info'], { CRONTICK_HOME: tmp });
      expect(info.stdout).toContain('paths');
      expect(info.stdout).toContain('daemon     not running');
      // The dashboard is always served by the daemon; info surfaces it. With no
      // daemon and no port file, the URL is unresolved and info notes that.
      expect(info.stdout).toContain('dashboard  available once the daemon is running');
      expect(existsSync(join(tmp, 'daemon.port'))).toBe(false);
      expect(existsSync(join(tmp, 'daemon.pid'))).toBe(false);
      expect(existsSync(join(tmp, 'daemon.ensure.lock'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 15_000);

  it('daemon stop and config render human output only', async () => {
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

      const config = cli(['config'], { CRONTICK_HOME: tmp });
      const lines = config.stdout.split(/\r?\n/);
      expect(lines[0]).toBe(join(tmp, 'config.json'));
      expect(lines[1]).toBe('');
      expect(lines.slice(2).join('\n').toLowerCase()).toContain('edit');
    } finally {
      stopDaemonInHome(tmp);
      await new Promise((r) => setTimeout(r, 300));
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 15_000);
});

// End-to-end tests with live daemon
describe('CLI e2e with daemon', () => {
  let dir: string;
  let daemonProc: ChildProcess;

  beforeAll(async () => {
    dir = makeTmpDir();
    const stderrChunks: string[] = [];
    daemonProc = spawn(process.execPath, [DAEMON_SCRIPT], { env: { ...process.env, CRONTICK_HOME: dir }, stdio: 'pipe' });
    daemonProc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));
    await waitForPortFile(dir, 30_000, () => stderrChunks.join(''));
  }, 30_000);

  afterAll(async () => {
    daemonProc?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const env = () => ({ CRONTICK_HOME: dir });

  it('jobs new --file creates an exec job; duplicate aliases require --force', () => {
    const { file, id } = writeJobFile(dir, 'e2e-job');
    const created = cli(['jobs', 'new', '--file', file], env());
    expect(created.status, created.stderr).toBe(0);
    expect(parseCliObject(created.stdout)).toMatchObject({ id, alias: 'e2e-job' });
    expect(parseCliObject(created.stdout).action).toMatchObject({ kind: 'exec', command: process.execPath, args: ['-e', 'process.exit(0)'] });
    expect(readFileSync(join(dir, 'jobs', `${id}.schema.json`), 'utf-8')).toBe(jobJsonSchemaText());

    const original = writeJobFile(dir, 'duplicate-cli-job', {
      schedule: { kind: 'interval', everySec: 60 },
      description: 'original cli definition',
      action: { kind: 'exec', command: process.execPath, args: ['-e', 'process.exit(0)'] },
    }).file;
    expect(cli(['jobs', 'new', '--file', original], env()).status).toBe(0);
    const replacement = writeJobFile(dir, 'duplicate-cli-job', {
      schedule: { kind: 'cron', cron: '15 6 * * *' },
      description: 'replacement cli definition',
      action: { kind: 'exec', command: process.execPath, args: ['-e', 'process.exit(1)'] },
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
    expect(parseCliObject(r.stdout).action).toMatchObject({ kind: 'prompt', prompt: 'Summarize', engine: 'copilot', args: [], reuseSession: false });

    r = cli(['jobs', 'new', '--alias', 'prompt-leading-dash-cli-job', '--cron', '0 9 * * *', '--prompt=- summarize'], env());
    expect(r.status, r.stderr).toBe(0);
    expect(parseCliObject(r.stdout).action).toMatchObject({ prompt: '- summarize' });

    const promptPath = join(dir, 'prompt.txt');
    writeFileSync(promptPath, 'Prompt from file', 'utf-8');
    r = cli(['jobs', 'new', '--alias', 'prompt-file-cli-job', '--cron', '0 10 * * *', '--prompt-file', promptPath, '--engine', 'agency', '--reuse-session', '--', '--silent', '--flag', 'one'], env());
    expect(r.status, r.stderr).toBe(0);
    expect(parseCliObject(r.stdout).action).toMatchObject({ prompt: 'Prompt from file', engine: 'agency', args: ['--silent', '--flag', 'one'], reuseSession: true });

    r = cli(['jobs', 'new', '--alias', 'prompt-session-cli-job', '--cron', '0 11 * * *', '--prompt', 'hello', '--session-id', 'sess-12345678', '--reuse-session'], env());
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('reuseSession was ignored');
    expect(parseCliObject(r.stdout).action).toMatchObject({ sessionId: 'sess-12345678', reuseSession: false });
  });

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
    const createFile = writeJobFile(dir, alias, { action: { kind: 'exec', command: process.execPath, args: ['-e', 'process.exit(0)'], env: { OPENAI_API_KEY: createSecret, NON_SECRET: 'https://example.test/job-visible' } } }).file;
    let result = cli(['jobs', 'new', '--file', createFile], env());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(createSecret);
    expect(parseCliObject(result.stdout).action).toMatchObject({ env: { OPENAI_API_KEY: '[REDACTED]', NON_SECRET: 'https://example.test/job-visible' } });
    result = cli(['jobs', 'get', alias], env());
    expect(result.stdout).not.toContain(createSecret);
    result = cli(['jobs', 'list'], env());
    expect(result.stdout).not.toContain(createSecret);
    expect(parseCliTable(result.stdout)).toContainEqual(expect.objectContaining({ alias, action: expect.objectContaining({ env: expect.objectContaining({ OPENAI_API_KEY: '[REDACTED]' }) }) }));
    const patchFile = writeJsonFile(dir, 'cli-redaction-job-update', { action: { kind: 'exec', command: process.execPath, args: ['-e', 'process.exit(0)'], env: { AWS_SECRET_ACCESS_KEY: updateSecret, NO_PASSWORD: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLl1Mm2Nn' } } });
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
    const { file } = writeJobFile(dir, 'merge-check-job', { schedule: { kind: 'cron', cron: '0 9 * * *' }, action: { kind: 'exec', command: 'echo', args: ['hi'] }, overlap: 'queue', retry: { max: 2, backoffSec: 30 } });
    expect(cli(['jobs', 'new', '--file', file], env()).status).toBe(0);
    let updated = cli(['jobs', 'update', 'merge-check-job', '--desc', 'merged'], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(parseCliObject(updated.stdout)).toMatchObject({ description: 'merged', overlap: 'queue', retry: { max: 2, backoffSec: 30 } });
    updated = cli(['jobs', 'update', 'merge-check-job', '--overlap', 'skip', '--disable'], env());
    expect(parseCliObject(updated.stdout)).toMatchObject({ overlap: 'skip', enabled: false });
    updated = cli(['jobs', 'update', 'merge-check-job', '--overlap', 'cancel-previous', '--enable'], env());
    expect(parseCliObject(updated.stdout)).toMatchObject({ overlap: 'cancel-previous', enabled: true });
    updated = cli(['jobs', 'update', 'merge-check-job', '--cron', '0 10 * * *', '--tz', 'UTC'], env());
    expect(parseCliObject(updated.stdout).schedule).toEqual({ kind: 'cron', cron: '0 10 * * *', tz: 'UTC' });
    const invalid = cli(['jobs', 'update', 'merge-check-job', '--enable', '--disable'], env());
    expectCleanError(invalid, 'VALIDATION_ERROR');
  });

  it('jobs update --file preserves and replaces action/retry fields through the core patch path', () => {
    const { file } = writeJobFile(dir, 'file-patch-job', { action: { kind: 'exec', command: 'echo', args: ['a', 'b'] } });
    expect(cli(['jobs', 'new', '--file', file], env()).status).toBe(0);
    const envFilePath = join(dir, 'file-exec-args.env');
    writeFileSync(envFilePath, 'FOO=bar\n', 'utf-8');
    let patchFile = writeJsonFile(dir, 'file-exec-args-patch', { action: { kind: 'exec', command: 'echo', envFile: envFilePath } });
    let updated = cli(['jobs', 'update', 'file-patch-job', '--file', patchFile], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(parseCliObject(updated.stdout).action).toMatchObject({ kind: 'exec', command: 'echo', args: ['a', 'b'], envFile: envFilePath });
    patchFile = writeJsonFile(dir, 'file-action-switch-patch', { action: { kind: 'script', script: 'echo done', shell: 'cmd' } });
    updated = cli(['jobs', 'update', 'file-patch-job', '--file', patchFile], env());
    expect(parseCliObject(updated.stdout).action).toMatchObject({ kind: 'script', script: 'echo done', shell: 'cmd' });
    patchFile = writeJsonFile(dir, 'file-retry-seed-patch', { retry: { max: 1, backoffSec: 90 } });
    updated = cli(['jobs', 'update', 'file-patch-job', '--file', patchFile], env());
    expect(parseCliObject(updated.stdout).retry).toEqual({ max: 1, backoffSec: 90 });
    patchFile = writeJsonFile(dir, 'file-retry-preserve-patch', { retry: { max: 3 } });
    updated = cli(['jobs', 'update', 'file-patch-job', '--file', patchFile], env());
    expect(parseCliObject(updated.stdout).retry).toEqual({ max: 3, backoffSec: 90 });
  });

  it('jobs update --file preserves prompt args/reuseSession/engine and fills default engine on kind change', () => {
    const created = cli(['jobs', 'new', '--alias', 'file-prompt-preserve-job', '--cron', '0 9 * * *', '--prompt', 'old', '--engine', 'agency', '--reuse-session', '--', '--flag'], env());
    expect(created.status, created.stderr).toBe(0);
    let patchFile = writeJsonFile(dir, 'file-prompt-preserve-patch', { action: { kind: 'prompt', prompt: 'new' } });
    let updated = cli(['jobs', 'update', 'file-prompt-preserve-job', '--file', patchFile], env());
    expect(updated.status, updated.stderr).toBe(0);
    expect(parseCliObject(updated.stdout).action).toMatchObject({ kind: 'prompt', prompt: 'new', args: ['--flag'], reuseSession: true, engine: 'agency' });

    const { file } = writeJobFile(dir, 'file-kind-change-engine-job');
    expect(cli(['jobs', 'new', '--file', file], env()).status).toBe(0);
    patchFile = writeJsonFile(dir, 'file-kind-change-engine-patch', { action: { kind: 'prompt', prompt: 'hello' } });
    updated = cli(['jobs', 'update', 'file-kind-change-engine-job', '--file', patchFile], env());
    expect(parseCliObject(updated.stdout).action).toMatchObject({ kind: 'prompt', prompt: 'hello', engine: 'copilot' });
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
    expect(run.id).toBe(runId);
    expect(run).toHaveProperty('command');
    expect(typeof run.outputTruncated).toBe('boolean');
    const listRuns = cli(['runs', 'list', '--job', 'e2e-job', '--limit', '5', '--status', 'success'], env());
    expect(listRuns.status, listRuns.stderr).toBe(0);
    const runs = parseCliTable<{ id: string; status: string }>(listRuns.stdout);
    expect(runs.every((listed) => listed.status === 'success')).toBe(true);
    expect(runs.some((listed) => listed.id === runId)).toBe(true);
    const logs = cli(['runs', 'logs', runId, '--tail', '5'], env());
    expect(logs.status, logs.stderr).toBe(0);
    expect(logs.stdout === '' || logs.stdout).toMatch(/^(|\[(stdout|stderr|crontick)\] )/);
    const engineLogs = cli(['runs', 'logs', runId, 'engine', '--tail', '5'], env());
    expect(engineLogs.status, engineLogs.stderr).toBe(0);
    expect(engineLogs.stdout).not.toContain('[crontick]');
    expect(parseCliObject(cli(['runs', 'cancel', runId], env()).stdout)).toMatchObject({ ok: true });
    expect(parseCliObject(cli(['runs', 'delete', runId], env()).stdout)).toMatchObject({ ok: true });
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

  it('jobs delete removes jobs and --all requires --force', () => {
    const del = cli(['jobs', 'delete', 'e2e-job'], env());
    expect(del.status, del.stderr).toBe(0);
    expectCleanError(cli(['jobs', 'get', 'e2e-job'], env()), 'JOB_NOT_FOUND');
    const withoutForce = cli(['jobs', 'delete', '--all'], env());
    expectCleanError(withoutForce, 'VALIDATION_ERROR');
    expect(withoutForce.stderr).toContain('requires --force');
    const withForce = cli(['jobs', 'delete', '--all', '--force'], env());
    expect(withForce.status, withForce.stderr).toBe(0);
    expect(parseCliObject(withForce.stdout)).toMatchObject({ ok: true });
  });

  it('share export/import handles stdout JSON, --out, include-runs, and BOM-prefixed imports', async () => {
    const { file, id } = writeJobFile(dir, 'import-export-job');
    expect(cli(['jobs', 'new', '--file', file], env()).status).toBe(0);
    const runNow = cli(['jobs', 'run-now', 'import-export-job'], env());
    const { runId } = parseCliObject<{ runId: string }>(runNow.stdout);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const exported = cli(['share', 'export'], env());
    expect(exported.status, exported.stderr).toBe(0);
    const data = JSON.parse(exported.stdout) as { jobs: Array<{ id: string; alias: string }>; runs?: unknown[] };
    expect(data.jobs.some((job) => job.alias === 'import-export-job')).toBe(true);
    expect(data.runs).toBeUndefined();
    const outFile = join(dir, 'export-out.json');
    const toFile = cli(['share', 'export', '--out', outFile], env());
    expect(toFile.status, toFile.stderr).toBe(0);
    expect(toFile.stdout.trim()).toBe(`Exported to ${outFile}`);
    expect(JSON.parse(readFileSync(outFile, 'utf-8')).jobs).toEqual(expect.any(Array));

    const withRuns = cli(['share', 'export', '--include-runs'], env());
    const withRunsData = JSON.parse(withRuns.stdout) as { runs: Array<{ id: string; jobId: string }> };
    expect(withRunsData.runs.some((run) => run.id === runId && run.jobId === id)).toBe(true);
    expect(cli(['jobs', 'delete', 'import-export-job'], env()).status).toBe(0);
    const importFile = join(dir, 'import-bom.json');
    writeFileSync(importFile, `\uFEFF${withRuns.stdout}`, 'utf-8');
    const imported = cli(['share', 'import', importFile], env());
    expect(imported.status, imported.stderr).toBe(0);
    expect(parseCliObject(imported.stdout).imported).toBe(1);
    const listRuns = cli(['runs', 'list', '--job', 'import-export-job'], env());
    expect(parseCliTable<{ id: string }>(listRuns.stdout).some((run) => run.id === runId)).toBe(true);
  }, 10_000);

  it('share import and jobs new/update --file report JSON parse errors without mutation', () => {
    const badImport = join(dir, 'import-bad.json');
    writeFileSync(badImport, '{ nope', 'utf-8');
    let result = cli(['share', 'import', badImport], env());
    expectCleanError(result, 'VALIDATION_ERROR');
    expect(result.stderr).toContain(badImport);
    expect(result.stderr).toContain('expected either a JSON array of jobs or an export object with jobs and optional runs');
    const eofImport = join(dir, 'import-eof.json');
    const eofContents = '{ "jobs": [ ';
    writeFileSync(eofImport, eofContents, 'utf-8');
    result = cli(['share', 'import', eofImport], env());
    expectCleanError(result, 'VALIDATION_ERROR');
    expect(result.stderr).toContain('Unexpected end of JSON input');
    expect(result.stderr).toContain(`position ${eofContents.length}`);

    const createJob = { id: nextUuid(), alias: 'cli-file-create-job', schedule: { kind: 'cron', cron: '0 12 * * *' }, action: { kind: 'exec', command: 'echo', args: ['bom-create'] } };
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
    writeFileSync(patchFile, `\uFEFF${JSON.stringify({ action: { kind: 'exec', command: 'echo', args: ['bom-update'] } })}`, 'utf-8');
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

  it('daemon, doctor, and runs delete-all render new human outputs', async () => {
    const status = cli(['daemon', 'status'], env());
    expect(status.status, status.stderr).toBe(0);
    expect(typeof parseCliObject(status.stdout).pid).toBe('number');
    expect(parseCliObject(status.stdout).missedFires).toMatchObject({ jobsWithMissedFires: expect.any(Number), missedRunsRecorded: expect.any(Number) });
    const doctor = cli(['doctor'], env());
    expect([0, 1]).toContain(doctor.status);
    expect(doctor.stdout).toContain('daemon reachable');
    // The dashboard has no command group; its URL is surfaced by `info` and it
    // is served by the daemon whenever it is up.
    const info = cli(['info'], env());
    expect(info.status, info.stderr).toBe(0);
    expect(info.stdout).toMatch(/dashboard\s+http:\/\/127\.0\.0\.1:\d+\/dashboard/);

    const { file } = writeJobFile(dir, 'runs-delete-all-job');
    expect(cli(['jobs', 'new', '--file', file], env()).status).toBe(0);
    expect(cli(['jobs', 'run-now', 'runs-delete-all-job'], env()).status).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const withoutForce = cli(['runs', 'delete', '--all'], env());
    expectCleanError(withoutForce, 'VALIDATION_ERROR');
  }, 8000);
});
