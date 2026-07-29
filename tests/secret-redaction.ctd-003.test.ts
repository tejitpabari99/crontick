import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { createClient } from '../src/client.js';
import { createApiServer } from '../src/daemon/api.js';
import { Runner } from '../src/daemon/runner.js';
import { Scheduler } from '../src/daemon/scheduler.js';
import { Store } from '../src/daemon/store.js';
import type { Job } from '../src/schemas/job.js';

const SCRATCH_ROOT = resolve('.crontick', 'secret-redaction-ctd-003');

const GITHUB_CLASSIC = `ghp_${'A'.repeat(36)}`;
const GITHUB_FINE_GRAINED = `github_pat_${'A'.repeat(28)}`;
const GITHUB_VARIANTS = [
  `gho_${'B'.repeat(36)}`,
  `ghu_${'C'.repeat(36)}`,
  `ghs_${'D'.repeat(36)}`,
  `ghr_${'E'.repeat(36)}`,
].join(' ');
const OPENAI_PROJECT = `sk-proj-${'F'.repeat(28)}`;
const OPENAI_GENERIC = `sk-${'G'.repeat(28)}`;
const ANTHROPIC_KEY = `sk-ant-${'H'.repeat(28)}`;
const STRIPE_KEYS = [`sk_live_${'I'.repeat(24)}`, `rk_live_${'J'.repeat(24)}`].join(' ');
const SLACK_TOKENS = [
  `xoxb-${'K'.repeat(12)}`,
  `xoxp-${'L'.repeat(12)}`,
  `xoxa-${'M'.repeat(12)}`,
  `xoxr-${'N'.repeat(12)}`,
  `xoxs-${'O'.repeat(12)}`,
].join(' ');
const AWS_ACCESS_KEY_ID = 'AKIA1234567890ABCDEF';
const AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const GOOGLE_API_KEY = `AIza${'P'.repeat(35)}`;
const AZURE_SUBSCRIPTION_KEY = '0123456789abcdef0123456789abcdef';
const JWT = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkNyb250aWNrIn0',
  'signature0123456789abcdef',
].join('.');
const PRIVATE_KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD',
  '-----END PRIVATE KEY-----',
].join('\n');
const GENERIC_ASSIGNMENTS = 'password=hunter2 passwd=unix-secret api_key=service-secret token=refresh-secret secret=shared-secret';
const BEARER_HEADER = `Authorization: Bearer ${JWT}`;
const POSTGRES_URL = 'postgres://dbuser:DbPass123!@db.example.local/app';
const MONGODB_URL = 'mongodb://mongo:MongoPass456!@cluster.example.local/test';
const CONNECTION_STRINGS = `${POSTGRES_URL} ${MONGODB_URL}`;
const PLAIN_VALUE = 'project-alpha-2026';

interface SecretCase {
  name: string;
  runtimeText: string;
  expectedRuntime: string;
  rawSecrets: string[];
  configKey: string;
  configValue: string;
  expectedConfig: string;
}

const SECRET_CASES: SecretCase[] = [
  {
    name: 'github classic pat',
    runtimeText: GITHUB_CLASSIC,
    expectedRuntime: '[REDACTED]',
    rawSecrets: [GITHUB_CLASSIC],
    configKey: 'GITHUB_TOKEN',
    configValue: GITHUB_CLASSIC,
    expectedConfig: '[REDACTED]',
  },
  {
    name: 'github fine-grained pat',
    runtimeText: GITHUB_FINE_GRAINED,
    expectedRuntime: '[REDACTED]',
    rawSecrets: [GITHUB_FINE_GRAINED],
    configKey: 'GITHUB_FINE_GRAINED',
    configValue: GITHUB_FINE_GRAINED,
    expectedConfig: '[REDACTED]',
  },
  {
    name: 'github token variants',
    runtimeText: GITHUB_VARIANTS,
    expectedRuntime: '[REDACTED] [REDACTED] [REDACTED] [REDACTED]',
    rawSecrets: GITHUB_VARIANTS.split(' '),
    configKey: 'GITHUB_VARIANTS',
    configValue: GITHUB_VARIANTS,
    expectedConfig: '[REDACTED] [REDACTED] [REDACTED] [REDACTED]',
  },
  {
    name: 'openai project key',
    runtimeText: OPENAI_PROJECT,
    expectedRuntime: '[REDACTED]',
    rawSecrets: [OPENAI_PROJECT],
    configKey: 'OPENAI_API_KEY',
    configValue: OPENAI_PROJECT,
    expectedConfig: '[REDACTED]',
  },
  {
    name: 'openai generic key',
    runtimeText: OPENAI_GENERIC,
    expectedRuntime: '[REDACTED]',
    rawSecrets: [OPENAI_GENERIC],
    configKey: 'OPENAI_GENERIC',
    configValue: OPENAI_GENERIC,
    expectedConfig: '[REDACTED]',
  },
  {
    name: 'anthropic key',
    runtimeText: ANTHROPIC_KEY,
    expectedRuntime: '[REDACTED]',
    rawSecrets: [ANTHROPIC_KEY],
    configKey: 'ANTHROPIC_API_KEY',
    configValue: ANTHROPIC_KEY,
    expectedConfig: '[REDACTED]',
  },
  {
    name: 'stripe live keys',
    runtimeText: STRIPE_KEYS,
    expectedRuntime: '[REDACTED] [REDACTED]',
    rawSecrets: STRIPE_KEYS.split(' '),
    configKey: 'STRIPE_VALUES',
    configValue: STRIPE_KEYS,
    expectedConfig: '[REDACTED] [REDACTED]',
  },
  {
    name: 'slack tokens',
    runtimeText: SLACK_TOKENS,
    expectedRuntime: '[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]',
    rawSecrets: SLACK_TOKENS.split(' '),
    configKey: 'SLACK_VALUES',
    configValue: SLACK_TOKENS,
    expectedConfig: '[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]',
  },
  {
    name: 'aws access and secret key',
    runtimeText: `${AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}`,
    expectedRuntime: '[REDACTED] AWS_SECRET_ACCESS_KEY=[REDACTED]',
    rawSecrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY],
    configKey: 'AWS_CREDS',
    configValue: `${AWS_ACCESS_KEY_ID} AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}`,
    expectedConfig: '[REDACTED] AWS_SECRET_ACCESS_KEY=[REDACTED]',
  },
  {
    name: 'google api key',
    runtimeText: GOOGLE_API_KEY,
    expectedRuntime: '[REDACTED]',
    rawSecrets: [GOOGLE_API_KEY],
    configKey: 'GOOGLE_API_KEY',
    configValue: GOOGLE_API_KEY,
    expectedConfig: '[REDACTED]',
  },
  {
    name: 'azure subscription key',
    runtimeText: `Ocp-Apim-Subscription-Key=${AZURE_SUBSCRIPTION_KEY}`,
    expectedRuntime: 'Ocp-Apim-Subscription-Key=[REDACTED]',
    rawSecrets: [AZURE_SUBSCRIPTION_KEY],
    configKey: 'AZURE_HEADERS',
    configValue: `Ocp-Apim-Subscription-Key=${AZURE_SUBSCRIPTION_KEY}`,
    expectedConfig: 'Ocp-Apim-Subscription-Key=[REDACTED]',
  },
  {
    name: 'jwt',
    runtimeText: JWT,
    expectedRuntime: '[REDACTED]',
    rawSecrets: [JWT],
    configKey: 'SESSION_BLOB',
    configValue: JWT,
    expectedConfig: '[REDACTED]',
  },
  {
    name: 'private key pem block',
    runtimeText: PRIVATE_KEY,
    expectedRuntime: '[REDACTED]',
    rawSecrets: [PRIVATE_KEY],
    configKey: 'CERTIFICATE_DATA',
    configValue: PRIVATE_KEY,
    expectedConfig: '[REDACTED]',
  },
  {
    name: 'generic assignments',
    runtimeText: GENERIC_ASSIGNMENTS,
    expectedRuntime: 'password=[REDACTED] passwd=[REDACTED] api_key=[REDACTED] token=[REDACTED] secret=[REDACTED]',
    rawSecrets: ['hunter2', 'unix-secret', 'service-secret', 'refresh-secret', 'shared-secret'],
    configKey: 'SERVICE_ARGS',
    configValue: GENERIC_ASSIGNMENTS,
    expectedConfig: 'password=[REDACTED] passwd=[REDACTED] api_key=[REDACTED] token=[REDACTED] secret=[REDACTED]',
  },
  {
    name: 'authorization bearer header',
    runtimeText: BEARER_HEADER,
    expectedRuntime: 'Authorization: Bearer [REDACTED]',
    rawSecrets: [JWT],
    configKey: 'REQUEST_AUTH',
    configValue: BEARER_HEADER,
    expectedConfig: 'Authorization: Bearer [REDACTED]',
  },
  {
    name: 'connection strings',
    runtimeText: CONNECTION_STRINGS,
    expectedRuntime: 'postgres://dbuser:[REDACTED]@db.example.local/app mongodb://mongo:[REDACTED]@cluster.example.local/test',
    rawSecrets: [POSTGRES_URL, MONGODB_URL, 'DbPass123!', 'MongoPass456!'],
    configKey: 'CONNECTIONS',
    configValue: CONNECTION_STRINGS,
    expectedConfig: 'postgres://dbuser:[REDACTED]@db.example.local/app mongodb://mongo:[REDACTED]@cluster.example.local/test',
  },
];

function makeHome(prefix: string): string {
  const dir = resolve(SCRATCH_ROOT, `${prefix}-${randomUUID()}`);
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  return dir;
}

function makeStore(dir: string): Store {
  const store = new Store(join(dir, 'runs.db'), join(dir, 'jobs'));
  store.open();
  return store;
}

function jobWithEnv(id: string, env: Record<string, string>): Job {
  return {
    id,
    enabled: true,
    schedule: { kind: 'cron', cron: '* * * * *' },
    action: {
      kind: 'exec',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env,
    },
    overlap: 'skip',
    retry: { max: 0, backoffSec: 0 },
  };
}

function fakeSpawnWithOutput(text: string) {
  return ((_cmd: string, _args?: readonly string[], _opts?: SpawnOptions): ChildProcess => {
    void _cmd;
    void _args;
    void _opts;
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, {
      stdout,
      stderr,
      pid: 12345,
      kill: () => true,
      unref: () => child,
    });
    queueMicrotask(() => {
      stdout.end(Buffer.from(text, 'utf-8'));
      stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  }) as never;
}

function logText(store: Store, runId: string): string {
  return Buffer.concat(store.getLogs(runId).map((entry) => entry.chunk)).toString('utf-8');
}

function writeConfig(dir: string, env: Record<string, string>): void {
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify({
    defaultEngine: 'copilot',
    engines: {
      copilot: {
        command: 'copilot',
        args: [],
        env,
      },
    },
  }, null, 2)}\n`, 'utf-8');
}

async function createFixture(prefix: string) {
  const dir = makeHome(prefix);
  const store = makeStore(dir);
  const scheduler = new Scheduler();
  const ctx = {
    store,
    scheduler,
    runner: new Runner(),
    startedAt: new Date(),
    port: 0,
    reload: async () => {},
  };
  const server = createApiServer(ctx);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
    server.on('error', rejectListen);
  });
  ctx.port = (server.address() as AddressInfo).port;
  const client = createClient({
    daemonUrl: `http://127.0.0.1:${ctx.port}`,
    startDaemon: false,
    env: { ...process.env, CRONTICK_HOME: dir },
  });
  return {
    dir,
    store,
    client,
    scheduler,
    async close(): Promise<void> {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      scheduler.unscheduleAll();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function expectRedacted(text: string, rawSecrets: string[], expected: string, surface: string): void {
  for (const rawSecret of rawSecrets) {
    expect(text, `${surface} leaked ${rawSecret}`).not.toContain(rawSecret);
  }
  expect(text, `${surface} missing redaction marker`).toContain(expected);
}

describe('CTD-003 shared secret redaction', () => {
  it('redacts each secret shape across persisted logs, run get, logs tail, dashboard data, and config get', async () => {
    const fixture = await createFixture('matrix');
    try {
      writeConfig(
        fixture.dir,
        Object.fromEntries(SECRET_CASES.map((entry) => [entry.configKey, entry.configValue])),
      );

      const dashboardRunIds = new Map<string, string>();
      for (const [index, entry] of SECRET_CASES.entries()) {
        const captureRunner = new Runner(fakeSpawnWithOutput(entry.runtimeText));
        const captureJob = jobWithEnv(`ctd003-capture-${index}`, {});
        const captureRun = fixture.store.insertRun(captureJob.id);
        await captureRunner.run(captureJob, captureRun.id, fixture.store);
        expectRedacted(logText(fixture.store, captureRun.id), entry.rawSecrets, entry.expectedRuntime, `${entry.name} persisted log bytes`);

        const dashboardJob = jobWithEnv(`ctd003-dashboard-${index}`, { EXPOSED_VALUE: entry.configValue });
        fixture.store.upsertJob(dashboardJob);

        const readRun = fixture.store.insertRun(`ctd003-read-${index}`);
        fixture.store.updateRun(readRun.id, {
          status: 'failed',
          endedAt: Date.now(),
          durationMs: 1,
          exitCode: 1,
          error: `failure ${entry.runtimeText}`,
        });
        fixture.store.appendLog(readRun.id, 'stderr', Buffer.from(entry.runtimeText, 'utf-8'));
        dashboardRunIds.set(entry.name, readRun.id);

        const run = await fixture.client.getRun(readRun.id) as { error?: string };
        expectRedacted(JSON.stringify(run), entry.rawSecrets, `failure ${entry.expectedRuntime}`, `${entry.name} run get`);
        expect(run.error).toBe(`failure ${entry.expectedRuntime}`);

        const logs = await fixture.client.getLogs(readRun.id);
        const tailed = logs.lines.map((line) => line.data).join('');
        expectRedacted(tailed, entry.rawSecrets, entry.expectedRuntime, `${entry.name} logs tail`);

        const configValue = fixture.client.getConfigValue(`engines.copilot.env.${entry.configKey}`);
        const configText = typeof configValue === 'string' ? configValue : JSON.stringify(configValue);
        expectRedacted(configText, entry.rawSecrets, entry.expectedConfig, `${entry.name} config get`);
      }

      const dashboard = await fixture.client.dashboardData({ runsLimit: SECRET_CASES.length * 4 }) as {
        jobs: Array<{ id: string; job: { action: { env?: Record<string, string> } } }>;
        runs: Array<{ id: string; error: string | null }>;
      };
      for (const [index, entry] of SECRET_CASES.entries()) {
        const dashboardJob = dashboard.jobs.find((job) => job.id === `ctd003-dashboard-${index}`);
        expect(dashboardJob, `missing dashboard job for ${entry.name}`).toBeTruthy();
        const dashboardJobText = JSON.stringify(dashboardJob);
        expectRedacted(dashboardJobText, entry.rawSecrets, entry.expectedConfig, `${entry.name} dashboard job`);
        expect(dashboardJob?.job.action.env?.['EXPOSED_VALUE']).toBe(entry.expectedConfig);

        const dashboardRun = dashboard.runs.find((run) => run.id === dashboardRunIds.get(entry.name));
        expect(dashboardRun, `missing dashboard run for ${entry.name}`).toBeTruthy();
        const dashboardRunText = JSON.stringify(dashboardRun);
        expectRedacted(dashboardRunText, entry.rawSecrets, `failure ${entry.expectedRuntime}`, `${entry.name} dashboard run`);
        expect(dashboardRun?.error).toBe(`failure ${entry.expectedRuntime}`);
      }

      const fullConfig = fixture.client.getConfigValue();
      const fullConfigText = JSON.stringify(fullConfig);
      for (const entry of SECRET_CASES) {
        for (const rawSecret of entry.rawSecrets) {
          expect(fullConfigText).not.toContain(rawSecret);
        }
      }
    } finally {
      await fixture.close();
    }
  });

  it('does not redact a clearly non-secret ordinary value on any shared surface', async () => {
    const fixture = await createFixture('false-positive');
    try {
      writeConfig(fixture.dir, { PLAIN_VALUE });

      const captureRunner = new Runner(fakeSpawnWithOutput(PLAIN_VALUE));
      const captureJob = jobWithEnv('ctd003-plain-capture', {});
      const captureRun = fixture.store.insertRun(captureJob.id);
      await captureRunner.run(captureJob, captureRun.id, fixture.store);
      expect(logText(fixture.store, captureRun.id)).toBe(PLAIN_VALUE);

      const dashboardJob = jobWithEnv('ctd003-plain-dashboard', { EXPOSED_VALUE: PLAIN_VALUE });
      fixture.store.upsertJob(dashboardJob);

      const readRun = fixture.store.insertRun('ctd003-plain-read');
      fixture.store.updateRun(readRun.id, {
        status: 'failed',
        endedAt: Date.now(),
        durationMs: 1,
        exitCode: 1,
        error: `failure ${PLAIN_VALUE}`,
      });
      fixture.store.appendLog(readRun.id, 'stderr', Buffer.from(PLAIN_VALUE, 'utf-8'));

      const run = await fixture.client.getRun(readRun.id) as { error?: string };
      expect(run.error).toBe(`failure ${PLAIN_VALUE}`);
      expect(JSON.stringify(run)).not.toContain('[REDACTED]');

      const logs = await fixture.client.getLogs(readRun.id);
      expect(logs.lines.map((line) => line.data).join('')).toBe(PLAIN_VALUE);

      const configValue = fixture.client.getConfigValue('engines.copilot.env.PLAIN_VALUE');
      expect(configValue).toBe(PLAIN_VALUE);

      const dashboard = await fixture.client.dashboardData({ runsLimit: 10 }) as {
        jobs: Array<{ id: string; job: { action: { env?: Record<string, string> } } }>;
        runs: Array<{ id: string; error: string | null }>;
      };
      expect(dashboard.jobs.find((job) => job.id === 'ctd003-plain-dashboard')?.job.action.env?.['EXPOSED_VALUE']).toBe(PLAIN_VALUE);
      expect(dashboard.runs.find((run) => run.id === readRun.id)?.error).toBe(`failure ${PLAIN_VALUE}`);
      expect(JSON.stringify(dashboard)).not.toContain('[REDACTED]');

      expect(JSON.stringify(fixture.client.getConfigValue())).toContain(PLAIN_VALUE);
    } finally {
      await fixture.close();
    }
  });
});
