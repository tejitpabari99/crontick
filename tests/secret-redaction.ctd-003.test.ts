import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { createClient } from '../src/client.js';
import { createApiServer } from '../src/daemon/api.js';
import { Runner } from '../src/daemon/runner.js';
import { createLogger, redactText } from '../src/logger.js';
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
const AWS_SESSION_ACCESS_KEY_ID = 'ASIA1234567890ABCDEF';
const AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const GOOGLE_API_KEY = `AIza${'P'.repeat(35)}`;
const AZURE_SUBSCRIPTION_KEY = '0123456789abcdef0123456789abcdef';
const JWT = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkNyb250aWNrIn0',
  'signature0123456789abcdef',
].join('.');
const PRIVATE_KEY_LINES = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD',
  '-----END PRIVATE KEY-----',
] as const;
const PRIVATE_KEY = PRIVATE_KEY_LINES.join('\n');
const PRIVATE_KEY_BEGIN_MARKER = PRIVATE_KEY_LINES[0];
const PRIVATE_KEY_END_MARKER = '-----END RSA PRIVATE KEY-----';
const GENERIC_ASSIGNMENTS = 'password=hunter2 passwd=unix-secret api_key=service-secret token=refresh-secret secret=shared-secret';
const BEARER_HEADER = `Authorization: Bearer ${JWT}`;
const POSTGRES_URL = 'postgres://dbuser:DbPass123!@db.example.local/app';
const MONGODB_URL = 'mongodb://mongo:MongoPass456!@cluster.example.local/test';
const CONNECTION_STRINGS = `${POSTGRES_URL} ${MONGODB_URL}`;
const BENIGN_WINDOWS_PATH = String.raw`C:\Users\Example\project-alpha`;
const BENIGN_URL = 'https://example.test/maps?mode=public';
const BENIGN_40_CHAR = 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0KkLl1Mm2Nn';
const QA_BENIGN_BASE64 = 'aGVsbG8gd29ybGQgZnJvbSBjcm9udGljayBxYQ==';
const BENIGN_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArandompublickey',
  '-----END PUBLIC KEY-----',
].join('\n');
const BENIGN_CERTIFICATE = [
  '-----BEGIN CERTIFICATE-----',
  'MIICdzCCAl+gAwIBAgIURandomCertificatePayload',
  '-----END CERTIFICATE-----',
].join('\n');
const BENIGN_LITERAL_VALUES = [
  BENIGN_WINDOWS_PATH,
  BENIGN_URL,
  'secretary',
  'monkey',
  BENIGN_40_CHAR,
  `payload: ${QA_BENIGN_BASE64}`,
  BENIGN_PUBLIC_KEY,
  BENIGN_CERTIFICATE,
] as const;
const BENIGN_RUNTIME_TEXT = BENIGN_LITERAL_VALUES.join('\n');
const BENIGN_CONFIG_ENV = {
  NON_SECRET: BENIGN_WINDOWS_PATH,
  NOT_TOKEN: BENIGN_URL,
  NO_PASSWORD: BENIGN_40_CHAR,
  PUBLIC_KEY: BENIGN_PUBLIC_KEY,
  CERTIFICATE_DATA: BENIGN_CERTIFICATE,
  SECRETARY: 'secretary',
  MONKEY: 'monkey',
  BASE64_VALUE: QA_BENIGN_BASE64,
} as const;

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
    name: 'aws session access and secret key',
    runtimeText: `${AWS_SESSION_ACCESS_KEY_ID} ${AWS_SECRET_ACCESS_KEY}`,
    expectedRuntime: '[REDACTED] [REDACTED]',
    rawSecrets: [AWS_SESSION_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY],
    configKey: 'AWS_SESSION_PAIR',
    configValue: `${AWS_SESSION_ACCESS_KEY_ID} ${AWS_SECRET_ACCESS_KEY}`,
    expectedConfig: '[REDACTED] [REDACTED]',
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
    name: 'private key begin marker',
    runtimeText: PRIVATE_KEY_BEGIN_MARKER,
    expectedRuntime: '[REDACTED]',
    rawSecrets: [PRIVATE_KEY_BEGIN_MARKER],
    configKey: 'PEM_BEGIN_ONLY',
    configValue: PRIVATE_KEY_BEGIN_MARKER,
    expectedConfig: '[REDACTED]',
  },
  {
    name: 'private key end marker',
    runtimeText: PRIVATE_KEY_END_MARKER,
    expectedRuntime: '[REDACTED]',
    rawSecrets: [PRIVATE_KEY_END_MARKER],
    configKey: 'PEM_END_ONLY',
    configValue: PRIVATE_KEY_END_MARKER,
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
    expectedRuntime: 'Authorization: [REDACTED] [REDACTED]',
    rawSecrets: [JWT],
    configKey: 'REQUEST_AUTH',
    configValue: BEARER_HEADER,
    expectedConfig: 'Authorization: [REDACTED] [REDACTED]',
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

type SpawnWrite = {
  stream: 'stdout' | 'stderr';
  chunk: string | Buffer;
};

function fakeSpawnWithWrites(writes: readonly SpawnWrite[]) {
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
      for (const { stream, chunk } of writes) {
        const target = stream === 'stdout' ? stdout : stderr;
        target.write(typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk);
      }
      stdout.end();
      stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  }) as never;
}

function fakeSpawnWithOutput(text: string) {
  return fakeSpawnWithWrites([{ stream: 'stdout', chunk: text }]);
}

function logText(store: Store, runId: string): string {
  return Buffer.concat(store.getLogs(runId).map((entry) => entry.chunk)).toString('utf-8');
}

function persistedLogBytes(dir: string, runId: string): Buffer {
  const db = new DatabaseSync(join(dir, 'runs.db'));
  try {
    const rows = db.prepare('SELECT chunk FROM run_logs WHERE run_id = ? ORDER BY id')
      .all(runId) as Array<{ chunk: Uint8Array }>;
    return Buffer.concat(rows.map((row) => Buffer.from(row.chunk)));
  } finally {
    db.close();
  }
}

function expectRawSecretBytesAbsent(buffer: Buffer, rawSecrets: string[], surface: string): void {
  for (const rawSecret of rawSecrets) {
    expect(buffer.includes(Buffer.from(rawSecret, 'utf-8')), `${surface} leaked raw bytes for ${rawSecret}`).toBe(false);
  }
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

function expectNoRedactionMarker(text: string, surface: string): void {
  expect(text, `${surface} should preserve benign values`).not.toContain('[REDACTED]');
}

describe('CTD-003 shared secret redaction', () => {
  it('RED-001/RED-002 redacts the must-redact corpus across runtime, config, dashboard, and export surfaces', async () => {
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
        const logBytes = persistedLogBytes(fixture.dir, captureRun.id);
        expectRawSecretBytesAbsent(logBytes, entry.rawSecrets, `${entry.name} persisted log bytes`);
        expectRedacted(logBytes.toString('utf-8'), entry.rawSecrets, entry.expectedRuntime, `${entry.name} persisted log text`);

        const dashboardJob = jobWithEnv(`ctd003-dashboard-${index}`, { EXPOSED_VALUE: entry.configValue });
        fixture.store.upsertJob(dashboardJob);

        const readJob = jobWithEnv(`ctd003-read-${index}`, {});
        fixture.store.upsertJob(readJob);
        const readRun = fixture.store.insertRun(readJob.id);
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

        const engines = fixture.client.listEngines();
        const enginesText = JSON.stringify(engines);
        expectRedacted(enginesText, entry.rawSecrets, entry.expectedConfig, `${entry.name} config engines`);
        expect(engines.copilot?.env?.[entry.configKey]).toBe(entry.expectedConfig);

        const validation = fixture.client.validateConfig();
        const validationText = JSON.stringify(validation);
        expectRedacted(validationText, entry.rawSecrets, entry.expectedConfig, `${entry.name} config validate`);
        expect(validation.config?.engines.copilot?.env?.[entry.configKey]).toBe(entry.expectedConfig);
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

      const fullConfig = fixture.client.getConfig();
      const fullConfigText = JSON.stringify(fullConfig);
      for (const entry of SECRET_CASES) {
        for (const rawSecret of entry.rawSecrets) {
          expect(fullConfigText).not.toContain(rawSecret);
        }
        expect(fullConfig.engines.copilot.env[entry.configKey]).toBe(entry.expectedConfig);
      }

      const exported = await fixture.client.exportJobs({ includeRuns: true }) as {
        jobs: Array<{ id: string; action: { env?: Record<string, string> } }>;
        runs?: Array<{ id: string; error?: string | null }>;
      };
      const exportedText = JSON.stringify(exported);
      for (const [index, entry] of SECRET_CASES.entries()) {
        expectRedacted(exportedText, entry.rawSecrets, entry.expectedConfig, `${entry.name} export payload`);
        expect(exported.jobs.find((job) => job.id === `ctd003-dashboard-${index}`)?.action.env?.['EXPOSED_VALUE']).toBe(entry.expectedConfig);
        expect(exported.runs?.find((run) => run.id === dashboardRunIds.get(entry.name))?.error).toBe(`failure ${entry.expectedRuntime}`);
      }
    } finally {
      await fixture.close();
    }
  }, 20_000);



  it('RED-003 redacts a chunk-split stdout private key before persistence without altering benign chunked output', async () => {
    const fixture = await createFixture('split-pem');
    try {
      const splitPemRunner = new Runner(fakeSpawnWithWrites([
        { stream: 'stdout', chunk: 'alpha ' },
        { stream: 'stdout', chunk: 'beta\n-----BEGIN PRIVA' },
        { stream: 'stdout', chunk: 'TE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B' },
        { stream: 'stdout', chunk: 'AQEFAASCBKcwggSjAgEAAoIBAQD\n-----END PRI' },
        { stream: 'stdout', chunk: 'VATE KEY-----\nomega delta\n' },
      ]));
      const captureJob = jobWithEnv('ctd003-split-pem-capture', {});
      const captureRun = fixture.store.insertRun(captureJob.id);
      await splitPemRunner.run(captureJob, captureRun.id, fixture.store);

      const logBytes = persistedLogBytes(fixture.dir, captureRun.id);
      expectRawSecretBytesAbsent(logBytes, [...PRIVATE_KEY_LINES, PRIVATE_KEY], 'split pem persisted log bytes');
      expect(logBytes.toString('utf-8')).toBe('alpha beta\n[REDACTED]\nomega delta\n');
      expect(logText(fixture.store, captureRun.id)).toBe('alpha beta\n[REDACTED]\nomega delta\n');
    } finally {
      await fixture.close();
    }
  });


  it('RED-005 redacts chunk-split AWS secret assignments before they reach persisted logs', async () => {
    const fixture = await createFixture('split-aws-assignment');
    try {
      const splitSecretRunner = new Runner(fakeSpawnWithWrites([
        { stream: 'stdout', chunk: 'alpha AWS_SECRET_ACCESS_KE' },
        { stream: 'stdout', chunk: 'Y=wJalrXUtnFEMI/K7MDENG/bPxRfiC' },
        { stream: 'stdout', chunk: 'YEXAMPLEKEY omega\n' },
      ]));
      const captureJob = jobWithEnv('ctd003-split-aws-capture', {});
      const captureRun = fixture.store.insertRun(captureJob.id);
      await splitSecretRunner.run(captureJob, captureRun.id, fixture.store);

      const logBytes = persistedLogBytes(fixture.dir, captureRun.id);
      expectRawSecretBytesAbsent(logBytes, [AWS_SECRET_ACCESS_KEY], 'split aws assignment persisted log bytes');
      expect(logBytes.toString('utf-8')).toBe('alpha AWS_SECRET_ACCESS_KEY=[REDACTED] omega\n');
      expect(logText(fixture.store, captureRun.id)).toBe('alpha AWS_SECRET_ACCESS_KEY=[REDACTED] omega\n');
    } finally {
      await fixture.close();
    }
  });

  it('SEC-1 redacts job create/get/list/update responses on the client surface while preserving benign env values', async () => {
    const fixture = await createFixture('job-response-redaction');
    try {
      const jobId = 'ctd003-job-response-redaction';
      const created = await fixture.client.createJob({
        id: jobId,
        schedule: { kind: 'cron', cron: '0 0 * * *' },
        action: {
          kind: 'exec',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          env: {
            OPENAI_API_KEY: OPENAI_PROJECT,
            NON_SECRET: BENIGN_WINDOWS_PATH,
          },
        },
      });
      expect(JSON.stringify(created)).not.toContain(OPENAI_PROJECT);
      expect((created.action as { env?: Record<string, string> }).env).toMatchObject({
        OPENAI_API_KEY: '[REDACTED]',
        NON_SECRET: BENIGN_WINDOWS_PATH,
      });

      const fetched = await fixture.client.getJob(jobId);
      expect(JSON.stringify(fetched)).not.toContain(OPENAI_PROJECT);
      expect((fetched.action as { env?: Record<string, string> }).env).toMatchObject({
        OPENAI_API_KEY: '[REDACTED]',
        NON_SECRET: BENIGN_WINDOWS_PATH,
      });

      const listed = await fixture.client.listJobs();
      const listedJob = listed.find((job) => job.id === jobId);
      expect(listedJob).toBeTruthy();
      expect(JSON.stringify(listedJob)).not.toContain(OPENAI_PROJECT);
      expect(((listedJob as Job).action as { env?: Record<string, string> }).env).toMatchObject({
        OPENAI_API_KEY: '[REDACTED]',
        NON_SECRET: BENIGN_WINDOWS_PATH,
      });

      const updated = await fixture.client.updateJob(jobId, {
        description: 'updated secret env',
        action: {
          kind: 'exec',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          env: {
            AWS_SECRET_ACCESS_KEY,
            NO_PASSWORD: BENIGN_40_CHAR,
          },
        },
      });
      expect(JSON.stringify(updated)).not.toContain(AWS_SECRET_ACCESS_KEY);
      expect((updated.action as { env?: Record<string, string> }).env).toMatchObject({
        AWS_SECRET_ACCESS_KEY: '[REDACTED]',
        NO_PASSWORD: BENIGN_40_CHAR,
      });

      const disabled = await fixture.client.disableJob(jobId);
      expect(JSON.stringify(disabled)).not.toContain(AWS_SECRET_ACCESS_KEY);
      expect(disabled.enabled).toBe(false);
      expect((disabled.action as { env?: Record<string, string> }).env).toMatchObject({
        AWS_SECRET_ACCESS_KEY: '[REDACTED]',
        NO_PASSWORD: BENIGN_40_CHAR,
      });

      const reenabled = await fixture.client.enableJob(jobId);
      expect(JSON.stringify(reenabled)).not.toContain(AWS_SECRET_ACCESS_KEY);
      expect(reenabled.enabled).toBe(true);
      expect((reenabled.action as { env?: Record<string, string> }).env).toMatchObject({
        AWS_SECRET_ACCESS_KEY: '[REDACTED]',
        NO_PASSWORD: BENIGN_40_CHAR,
      });

      const refetched = await fixture.client.getJob(jobId);
      expect(JSON.stringify(refetched)).not.toContain(AWS_SECRET_ACCESS_KEY);
      expect((refetched.action as { env?: Record<string, string> }).env).toMatchObject({
        AWS_SECRET_ACCESS_KEY: '[REDACTED]',
        NO_PASSWORD: BENIGN_40_CHAR,
      });
    } finally {
      await fixture.close();
    }
  });

  it('SEC-2 redacts config mutation responses on the client surface while preserving substring-trap keys', async () => {
    const fixture = await createFixture('config-response-redaction');
    try {
      fixture.client.initConfig({ force: true });

      const setResult = fixture.client.setConfigValue('engines.copilot.env', {
        OPENAI_API_KEY: OPENAI_GENERIC,
        NON_SECRET: BENIGN_WINDOWS_PATH,
      });
      expect(JSON.stringify(setResult)).not.toContain(OPENAI_GENERIC);
      expect(setResult.engines.copilot.env).toMatchObject({
        OPENAI_API_KEY: '[REDACTED]',
        NON_SECRET: BENIGN_WINDOWS_PATH,
      });

      const added = fixture.client.addEngine('client-redaction-engine', {
        command: 'agency',
        args: ['cp'],
        env: {
          OPENAI_API_KEY: OPENAI_PROJECT,
          NON_SECRET: BENIGN_URL,
        },
      });
      expect(JSON.stringify(added)).not.toContain(OPENAI_PROJECT);
      expect(added.engines['client-redaction-engine']?.env).toMatchObject({
        OPENAI_API_KEY: '[REDACTED]',
        NON_SECRET: BENIGN_URL,
      });

      const updated = fixture.client.updateEngine('client-redaction-engine', {
        env: {
          AWS_SECRET_ACCESS_KEY,
          NO_PASSWORD: BENIGN_40_CHAR,
        },
      });
      expect(JSON.stringify(updated)).not.toContain(AWS_SECRET_ACCESS_KEY);
      expect(updated.engines['client-redaction-engine']?.env).toMatchObject({
        AWS_SECRET_ACCESS_KEY: '[REDACTED]',
        NO_PASSWORD: BENIGN_40_CHAR,
      });
    } finally {
      await fixture.close();
    }
  });

  it('RED-004 redacts daemon operational logs with the shared logger contract while preserving benign fields', () => {
    const events: Array<{ message: string; data?: { env?: Record<string, string> } }> = [];
    const logger = createLogger({
      verbose: true,
      component: 'daemon',
      sink: (event) => events.push(event as { message: string; data?: { env?: Record<string, string> } }),
    });

    logger.info(
      `runtime AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY} bare=${AWS_SECRET_ACCESS_KEY}\npaired=${AWS_ACCESS_KEY_ID} ${AWS_SECRET_ACCESS_KEY} begin=${PRIVATE_KEY_BEGIN_MARKER} path=${BENIGN_WINDOWS_PATH} url=${BENIGN_URL}`,
      {
        env: {
          AWS_SECRET_ACCESS_KEY,
          RUNTIME_SAMPLE: AWS_SECRET_ACCESS_KEY,
          AWS_SESSION_PAIR: `${AWS_SESSION_ACCESS_KEY_ID} ${AWS_SECRET_ACCESS_KEY}`,
          PRIVATE_KEY,
          PEM_BEGIN_ONLY: PRIVATE_KEY_BEGIN_MARKER,
          PEM_END_ONLY: PRIVATE_KEY_END_MARKER,
          GITHUB_TOKEN: GITHUB_CLASSIC,
          ...BENIGN_CONFIG_ENV,
        },
      },
    );

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.message).toContain('AWS_SECRET_ACCESS_KEY=[REDACTED]');
    expect(event?.message).toContain(`bare=${AWS_SECRET_ACCESS_KEY}`);
    expect(event?.message).toContain('paired=[REDACTED] [REDACTED]');
    expect(event?.message).toContain('begin=[REDACTED]');
    expect(event?.message).toContain(`path=${BENIGN_WINDOWS_PATH}`);
    expect(event?.message).toContain(`url=${BENIGN_URL}`);
    expect(event?.message).toContain(AWS_SECRET_ACCESS_KEY);
    expect(event?.message).not.toContain(PRIVATE_KEY_BEGIN_MARKER);
    expect(event?.message).not.toContain(PRIVATE_KEY_END_MARKER);
    expect(event?.data?.env?.AWS_SECRET_ACCESS_KEY).toBe('[REDACTED]');
    expect(event?.data?.env?.RUNTIME_SAMPLE).toBe(AWS_SECRET_ACCESS_KEY);
    expect(event?.data?.env?.AWS_SESSION_PAIR).toBe('[REDACTED] [REDACTED]');
    expect(event?.data?.env?.PRIVATE_KEY).toBe('[REDACTED]');
    expect(event?.data?.env?.PEM_BEGIN_ONLY).toBe('[REDACTED]');
    expect(event?.data?.env?.PEM_END_ONLY).toBe('[REDACTED]');
    expect(event?.data?.env?.GITHUB_TOKEN).toBe('[REDACTED]');
    for (const [key, value] of Object.entries(BENIGN_CONFIG_ENV)) {
      expect(event?.data?.env?.[key]).toBe(value);
    }
  });

  it('redacts generic assignment lookalikes in linear time on large non-matching input', () => {
    const adversarial = 'tokentoken.'.repeat(5_000);
    redactText('token=warmup');

    const startedAt = performance.now();
    const redacted = redactText(adversarial);
    const elapsedMs = performance.now() - startedAt;

    expect(redacted).toBe(adversarial);
    expect(elapsedMs).toBeLessThan(200);
  });

  it('SAFE-001/SAFE-002 preserves the must-not-redact runtime and config corpora on shared read surfaces', async () => {
    const fixture = await createFixture('false-positive');
    try {
      writeConfig(fixture.dir, { ...BENIGN_CONFIG_ENV });

      const captureRunner = new Runner(fakeSpawnWithOutput(BENIGN_RUNTIME_TEXT));
      const captureJob = jobWithEnv('ctd003-benign-capture', {});
      const captureRun = fixture.store.insertRun(captureJob.id);
      await captureRunner.run(captureJob, captureRun.id, fixture.store);
      expect(logText(fixture.store, captureRun.id)).toBe(BENIGN_RUNTIME_TEXT);
      expectNoRedactionMarker(logText(fixture.store, captureRun.id), 'benign persisted log text');
      expectRawSecretBytesAbsent(Buffer.from(logText(fixture.store, captureRun.id), 'utf-8'), ['[REDACTED]'], 'benign persisted log text');

      const dashboardJob = jobWithEnv('ctd003-benign-dashboard', { ...BENIGN_CONFIG_ENV });
      fixture.store.upsertJob(dashboardJob);

      const readJob = jobWithEnv('ctd003-benign-read', {});
      fixture.store.upsertJob(readJob);
      const readRun = fixture.store.insertRun(readJob.id);
      fixture.store.updateRun(readRun.id, {
        status: 'failed',
        endedAt: Date.now(),
        durationMs: 1,
        exitCode: 1,
        error: `failure ${BENIGN_RUNTIME_TEXT}`,
      });
      fixture.store.appendLog(readRun.id, 'stderr', Buffer.from(BENIGN_RUNTIME_TEXT, 'utf-8'));

      const run = await fixture.client.getRun(readRun.id) as { error?: string };
      expect(run.error).toBe(`failure ${BENIGN_RUNTIME_TEXT}`);
      expectNoRedactionMarker(JSON.stringify(run), 'benign run get');

      const logs = await fixture.client.getLogs(readRun.id);
      expect(logs.lines.map((line) => line.data).join('')).toBe(BENIGN_RUNTIME_TEXT);
      expectNoRedactionMarker(JSON.stringify(logs), 'benign logs tail');

      for (const [key, value] of Object.entries(BENIGN_CONFIG_ENV)) {
        expect(fixture.client.getConfigValue(`engines.copilot.env.${key}`)).toBe(value);
      }

      const engines = fixture.client.listEngines();
      expect(engines.copilot?.env).toEqual(BENIGN_CONFIG_ENV);
      expectNoRedactionMarker(JSON.stringify(engines), 'benign config engines');

      const validation = fixture.client.validateConfig();
      expect(validation.config?.engines.copilot?.env).toEqual(BENIGN_CONFIG_ENV);
      expectNoRedactionMarker(JSON.stringify(validation), 'benign config validate');

      const dashboard = await fixture.client.dashboardData({ runsLimit: 10 }) as {
        jobs: Array<{ id: string; job: { action: { env?: Record<string, string> } } }>;
        runs: Array<{ id: string; error: string | null }>;
      };
      expect(dashboard.jobs.find((job) => job.id === 'ctd003-benign-dashboard')?.job.action.env).toEqual(BENIGN_CONFIG_ENV);
      expect(dashboard.runs.find((run) => run.id === readRun.id)?.error).toBe(`failure ${BENIGN_RUNTIME_TEXT}`);
      expectNoRedactionMarker(JSON.stringify(dashboard), 'benign dashboard data');

      const fullConfig = fixture.client.getConfig();
      expect(fullConfig.engines.copilot.env).toEqual(BENIGN_CONFIG_ENV);
      expectNoRedactionMarker(JSON.stringify(fullConfig), 'benign getConfig');

      const exported = await fixture.client.exportJobs({ includeRuns: true }) as {
        jobs: Array<{ id: string; action: { env?: Record<string, string> } }>;
        runs?: Array<{ id: string; error?: string | null }>;
      };
      expect(exported.jobs.find((job) => job.id === 'ctd003-benign-dashboard')?.action.env).toEqual(BENIGN_CONFIG_ENV);
      expect(exported.runs?.find((run) => run.id === readRun.id)?.error).toBe(`failure ${BENIGN_RUNTIME_TEXT}`);
      expectNoRedactionMarker(JSON.stringify(exported), 'benign export payload');
    } finally {
      await fixture.close();
    }
  }, 20_000);
});


