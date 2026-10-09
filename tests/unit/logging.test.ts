import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '../../src/client.js';
import { createLogger, redactText, type LogEvent } from '../../src/logger.js';
import { Store } from '../../src/daemon/store.js';
import { Runner } from '../../src/daemon/runner.js';
import type { Job } from '../../src/schemas/job.js';
import { FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';

const CLI = resolve('dist/cli/index.js');

function home(name: string): string {
  const dir = resolve('.crontick', 'logging-tests', `${name}-${randomUUID()}`);
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

function cli(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function stopDaemonInHome(dir: string): void {
  const pidFile = join(dir, 'daemon.pid');
  if (!existsSync(pidFile)) return;
  const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  try { cli(['daemon', 'stop'], { CRONTICK_HOME: dir }); } catch { /* ignore cleanup failures */ }
  if (!Number.isNaN(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore cleanup failures */ }
  }
}

describe('core logger', () => {
  it('filters levels and redacts sensitive values', () => {
    const events: LogEvent[] = [];
    const logger = createLogger({ level: 'warn', sink: (event) => events.push(event) });
    logger.info('ignored');
    logger.warn('token=******', {
      password: 'secret-value',
      safe: 'ok',
    });

    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain('secret-value');
    expect(JSON.stringify(events[0])).not.toContain('******');
    expect(events[0].data).toMatchObject({ password: '[REDACTED]', safe: 'ok' });
  });

  it('redacts common secret-shaped text', () => {
    expect(redactText('Authorization: ******')).toContain('[REDACTED]');
    expect(redactText('GITHUB_TOKEN=******')).not.toContain('ghp_');
  });

  it('core source has no console output calls', () => {
    const root = resolve('src');
    const files = collectFiles(root).filter((file) => file.endsWith('.ts'));
    const offenders = files.filter((file) => readFileSync(file, 'utf-8').includes('console.'));
    expect(offenders).toEqual([]);
  });
});

describe('verbose propagation', () => {
  it('client verbose option emits debug diagnostics through onLog', () => {
    const events: LogEvent[] = [];
    const dir = home('client');
    try {
      const client = createClient({
        verbose: true,
        env: { ...process.env, CRONTICK_HOME: dir },
        onLog: (event) => events.push(event),
      });
      expect(client.isVerbose()).toBe(true);
      expect(client.getConfig()).toHaveProperty('engines');
      expect(events.some((event) => event.level === 'debug' && event.message.includes('Config'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CLI --verbose and CRONTICK_VERBOSE log to stderr without polluting human stdout', () => {
    const flagHome = home('cli-flag');
    const envHome = home('cli-env');
    try {
      const byFlag = cli(['--verbose', 'jobs', 'list'], { CRONTICK_HOME: flagHome });
      expect(byFlag.status, byFlag.stderr).toBe(0);
      expect(byFlag.stdout.trim()).toBe('(no items)');
      expect(byFlag.stdout).not.toContain('[crontick:debug]');
      expect(byFlag.stderr).toContain('[crontick:debug]');

      const byEnv = cli(['jobs', 'list'], { CRONTICK_HOME: envHome, CRONTICK_VERBOSE: '1' });
      expect(byEnv.status, byEnv.stderr).toBe(0);
      expect(byEnv.stdout.trim()).toBe('(no items)');
      expect(byEnv.stdout).not.toContain('[crontick:debug]');
      expect(byEnv.stderr).toContain('[crontick:debug]');
    } finally {
      stopDaemonInHome(flagHome);
      stopDaemonInHome(envHome);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      rmSync(flagHome, { recursive: true, force: true });
      rmSync(envHome, { recursive: true, force: true });
    }
  }, 20_000);

  it('runner verbose diagnostics are written to the job log file without dumping env values', async () => {
    const dir = home('runner');
    writeFakeEngineConfig(dir);
    const previousHome = process.env['CRONTICK_HOME'];
    process.env['CRONTICK_HOME'] = dir;
    const logger = createLogger({ verbose: true });
    const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'), logger);
    store.open();
    try {
      const job: Job = { catchUp: false,
        id: 'verbose-run',
        enabled: true,
        schedule: { kind: 'interval', everySec: 60 },
        action: {
          kind: 'prompt',
          prompt: 'process.exit(0)',
          engine: FAKE_ENGINE_NAME,
          args: [],
          reuseSession: false,
          env: { GITHUB_TOKEN: '******' },
        },
        overlap: 'skip',
        retry: { max: 0, backoffSec: 30 },
      };
      store.upsertJob(job);
      const run = store.insertRun(job.id);
      const writes: string[] = [];
      const files = { open: () => ({ write: (text: string) => { writes.push(text); } }) };
      await new Runner(undefined, logger, undefined, undefined, files).run(job, run.id, store);
      const text = writes.join('');
      expect(text).toContain('[debug] spawn');
      expect(text).not.toContain('******');
    } finally {
      store.close();
      if (previousHome === undefined) delete process.env['CRONTICK_HOME'];
      else process.env['CRONTICK_HOME'] = previousHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function collectFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? collectFiles(full) : [full];
    });
}
