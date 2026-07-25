import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '../src/client.js';
import { createLogger, redactText, type LogEvent } from '../src/logger.js';
import { Store } from '../src/daemon/store.js';
import { Runner } from '../src/daemon/runner.js';
import type { Job } from '../src/schemas/job.js';

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

describe('core logger', () => {
  it('filters levels and redacts sensitive values', () => {
    const events: LogEvent[] = [];
    const logger = createLogger({ level: 'warn', sink: (event) => events.push(event) });
    logger.info('ignored');
    logger.warn('token=ghp_123456789012345678901234567890123456', {
      password: 'secret-value',
      safe: 'ok',
    });

    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain('secret-value');
    expect(JSON.stringify(events[0])).not.toContain('ghp_123456789012345678901234567890123456');
    expect(events[0].data).toMatchObject({ password: '[REDACTED]', safe: 'ok' });
  });

  it('redacts common secret-shaped text', () => {
    expect(redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toContain('[REDACTED]');
    expect(redactText('GITHUB_TOKEN=ghp_123456789012345678901234567890123456')).not.toContain('ghp_');
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
      expect(client.getConfigValue()).toHaveProperty('engines');
      expect(events.some((event) => event.level === 'debug' && event.message.includes('Config'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CLI --verbose and CRONTICK_VERBOSE log to stderr without polluting JSON stdout', () => {
    const flagHome = home('cli-flag');
    const envHome = home('cli-env');
    try {
      const byFlag = cli(['--json', '--verbose', 'config', 'get'], { CRONTICK_HOME: flagHome });
      expect(byFlag.status, byFlag.stderr).toBe(0);
      expect(JSON.parse(byFlag.stdout)).toHaveProperty('engines');
      expect(byFlag.stdout).not.toContain('[crontick:debug]');
      expect(byFlag.stderr).toContain('[crontick:debug]');

      const byEnv = cli(['--json', 'config', 'validate'], { CRONTICK_HOME: envHome, CRONTICK_VERBOSE: '1' });
      expect(byEnv.status, byEnv.stderr).toBe(0);
      expect(JSON.parse(byEnv.stdout)).toMatchObject({ ok: true });
      expect(byEnv.stderr).toContain('[crontick:debug]');
    } finally {
      rmSync(flagHome, { recursive: true, force: true });
      rmSync(envHome, { recursive: true, force: true });
    }
  });

  it('runner verbose diagnostics are written to run logs without dumping env values', async () => {
    const dir = home('runner');
    const logger = createLogger({ verbose: true });
    const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'), logger);
    store.open();
    try {
      const job: Job = {
        id: 'verbose-run',
        enabled: true,
        schedule: { kind: 'interval', everySec: 60 },
        action: {
          kind: 'exec',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          env: { GITHUB_TOKEN: 'ghp_123456789012345678901234567890123456' },
        },
          overlap: 'skip',
        retry: { max: 0, backoffSec: 30 },
        };
      store.upsertJob(job);
      const run = store.insertRun(job.id);
      await new Runner(undefined, logger).run(job, run.id, store);
      const text = store.getLogs(run.id).map((entry) => entry.chunk.toString('utf-8')).join('');
      expect(text).toContain('[crontick:debug] spawn');
      expect(text).not.toContain('ghp_123456789012345678901234567890123456');
    } finally {
      store.close();
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
