import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '../src/client.js';
import {
  buildPromptRunCommand,
  getConfigValue,
  initConfig,
  loadConfig,
  setConfigValue,
  validateConfigFile,
  writeConfigFile,
} from '../src/config.js';
import { normalizeJobInput } from '../src/job-input.js';
import type { JobCreateInput } from '../src/job-input.js';

const scratchRoot = resolve('.crontick', 'config-tests');
const cleanupDirs: string[] = [];

function makeHome(): { home: string; env: NodeJS.ProcessEnv; path: string } {
  const home = join(scratchRoot, randomUUID());
  mkdirSync(home, { recursive: true });
  cleanupDirs.push(home);
  return { home, env: { ...process.env, CRONTICK_HOME: home }, path: join(home, 'config.json') };
}

function writeRawConfig(path: string, config: unknown): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

function promptJob(action: Record<string, unknown> = {}): JobCreateInput {
  return {
    id: 'prompt-job',
    schedule: { kind: 'cron', cron: '0 9 * * *' },
    action: { kind: 'prompt', prompt: 'hello', ...action },
  } as JobCreateInput;
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('crontick config core', () => {
  it('uses built-in defaults when the config file is missing', () => {
    const { env, path } = makeHome();

    expect(loadConfig({ env })).toEqual({
      defaultEngine: 'copilot',
      engines: { copilot: { command: 'copilot', args: [], env: {} } },
      retention: { maxRunsPerJob: 100 },
    });
    expect(validateConfigFile({ env })).toMatchObject({ ok: true, path, problems: [] });
  });

  it('validates a minimal custom config and merges built-in engines', () => {
    const { env, path } = makeHome();
    writeRawConfig(path, {
      defaultEngine: 'agency',
      engines: { agency: { command: 'agency', args: ['cp', '--logs-dir=XYZ'] } },
    });

    expect(loadConfig({ env })).toMatchObject({
      defaultEngine: 'agency',
      engines: {
        copilot: { command: 'copilot', args: [], env: {} },
        agency: { command: 'agency', args: ['cp', '--logs-dir=XYZ'], env: {} },
      },
    });
  });

  it('reports invalid JSON with file path and next step', () => {
    const { env, path } = makeHome();
    writeFileSync(path, '{ nope', 'utf-8');

    expect(() => loadConfig({ env })).toThrow(/Failed to read config file .*config\.json.*Fix the JSON syntax/);
    expect(validateConfigFile({ env })).toMatchObject({ ok: false, path });
  });

  it('reports unknown keys with key path and fix guidance', () => {
    const { env, path } = makeHome();
    writeRawConfig(path, { telemetry: true });

    expect(() => loadConfig({ env })).toThrow(/Invalid config file .* at telemetry: Unrecognized key.*documented config schema/);
  });

  it('reports defaultEngine values that do not name an engine', () => {
    const { env, path } = makeHome();
    writeRawConfig(path, { defaultEngine: 'missing-engine', engines: { copilot: { command: 'copilot' } } });

    expect(() => loadConfig({ env })).toThrow(/defaultEngine.*must match a key in engines/);
  });

  it('reports invalid engine command and args types', () => {
    const invalidCommand = makeHome();
    writeRawConfig(invalidCommand.path, { engines: { copilot: { command: '' } } });
    expect(() => loadConfig({ env: invalidCommand.env })).toThrow(/engines\.copilot\.command/);

    const invalidArgs = makeHome();
    writeRawConfig(invalidArgs.path, { engines: { copilot: { command: 'copilot', args: ['ok', 42] } } });
    expect(() => loadConfig({ env: invalidArgs.env })).toThrow(/engines\.copilot\.args\.1/);
  });

  it('applies config defaultEngine unless a per-job engine is explicit', () => {
    const { env, path } = makeHome();
    writeRawConfig(path, {
      defaultEngine: 'agency',
      engines: {
        agency: { command: 'agency', args: ['cp'] },
      },
    });

    expect(normalizeJobInput(promptJob(), { env }).action).toMatchObject({ engine: 'agency' });
    expect(normalizeJobInput(promptJob({ engine: 'copilot' }), { env }).action).toMatchObject({ engine: 'copilot' });
  });

  it('builds prompt run command from config command, defaults, prompt, flags, session, and env', () => {
    const { env, path } = makeHome();
    writeRawConfig(path, {
      defaultEngine: 'agency',
      engines: {
        agency: { command: 'agency', args: ['cp', '--logs-dir=XYZ'], env: { AGENCY_HOME: 'Q:\\Logs' } },
      },
    });

    expect(buildPromptRunCommand({
      kind: 'prompt',
      prompt: 'summarize',
      engine: 'agency',
      args: ['--model', 'fast'],
      sessionId: 'sess-12345678',
      reuseSession: false,
    }, { env })).toEqual({
      command: 'agency',
      args: ['cp', '--logs-dir=XYZ', 'summarize', '--model', 'fast', '--session-id=sess-12345678'],
      env: { AGENCY_HOME: 'Q:\\Logs' },
      engine: 'agency',
    });
  });

  it('supports client config CRUD', () => {
    const { env, path } = makeHome();
    const client = createClient({ env, startDaemon: false });

    expect(client.initConfig()).toMatchObject({ path, created: true });
    expect(readFileSync(path, 'utf-8')).toContain('"defaultEngine": "copilot"');
    expect(client.addEngine('agency', { command: 'agency', args: ['cp'], env: { LOGS: 'XYZ' } })).toMatchObject({
      engines: { agency: { command: 'agency', args: ['cp'], env: { LOGS: 'XYZ' } } },
    });
    expect(client.listEngines()).toHaveProperty('agency.command', 'agency');
    expect(client.updateEngine('agency', { args: ['cp', '--logs-dir=XYZ'] })).toMatchObject({
      engines: { agency: { args: ['cp', '--logs-dir=XYZ'] } },
    });
    expect(client.setConfigValue('defaultEngine', 'agency')).toMatchObject({ defaultEngine: 'agency' });
    expect(client.getConfigValue('engines.agency.args')).toEqual(['cp', '--logs-dir=XYZ']);
    expect(client.setConfigValue('defaultEngine', 'copilot')).toMatchObject({ defaultEngine: 'copilot' });
    expect(client.removeEngine('agency')).not.toHaveProperty('engines.agency');
    expect(client.removeConfigValue('engines.copilot.args')).toMatchObject({ engines: { copilot: { args: [] } } });
    expect(client.validateConfig()).toMatchObject({ ok: true, problems: [] });
  });

  it('retention.maxRunsPerJob defaults to 100 and round-trips through get/set', () => {
    const { env, path } = makeHome();

    // No config file at all: built-in default applies.
    expect(loadConfig({ env }).retention.maxRunsPerJob).toBe(100);

    // Custom config file that omits `retention` entirely: deep-merge keeps the default.
    writeRawConfig(path, { defaultEngine: 'copilot', engines: { copilot: { command: 'copilot' } } });
    expect(loadConfig({ env }).retention.maxRunsPerJob).toBe(100);

    setConfigValue('retention.maxRunsPerJob', 250, { env });
    expect(getConfigValue('retention.maxRunsPerJob', { env })).toBe(250);

    expect(() => setConfigValue('retention.maxRunsPerJob', 0, { env })).toThrow(/CONFIG_VALIDATION_ERROR|retention\.maxRunsPerJob/);
    expect(() => setConfigValue('retention.maxRunsPerJob', 1.5, { env })).toThrow(/CONFIG_VALIDATION_ERROR|retention\.maxRunsPerJob/);
  });

  it('initializes with force when the file already exists', () => {
    const { env, path } = makeHome();
    initConfig({ env });
    expect(() => initConfig({ env })).toThrow(/already exists/);
    writeConfigFile({ defaultEngine: 'copilot', engines: { copilot: { command: 'custom' } } }, { env });
    expect(loadConfig({ env }).engines.copilot.command).toBe('custom');
    expect(initConfig({ env, force: true })).toMatchObject({ path, created: true });
    expect(loadConfig({ env }).engines.copilot.command).toBe('copilot');
  });
});

