import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '../src/client.js';
import {
  buildPromptRunCommand,
  getConfigValue,
  initConfig,
  listEngines,
  loadConfig,
  removeConfigValue,
  setConfigValue,
  readConfigFile,
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

function expectConfigJsonError(fn: () => unknown, path: string, extraFragments: string[] = []): void {
  try {
    fn();
    throw new Error('Expected config read failure');
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SyntaxError);
    const message = (err as Error).message;
    expect(message).toContain(path);
    expect(message).toMatch(/line \d+ column \d+ \(position \d+\)/);
    expect(message).toContain('expected a JSON object matching the crontick config schema');
    expect(message).toContain('Fix the JSON syntax');
    for (const fragment of extraFragments) expect(message).toContain(fragment);
  }
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('crontick config core', () => {
  it('uses built-in defaults when the config file is missing', () => {
    const { env, path } = makeHome();

    expect(loadConfig({ env })).toEqual({
      defaultEngine: 'copilot',
      engines: { copilot: { command: 'copilot', args: ['--allow-all-tools', '-p'], env: {} } },
      retention: { maxRunsPerJob: 100, maxOutputBytesPerRun: 2_000_000, maxLogFiles: 30 },
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
        copilot: { command: 'copilot', args: ['--allow-all-tools', '-p'], env: {} },
        agency: { command: 'agency', args: ['cp', '--logs-dir=XYZ'], env: {} },
      },
    });
  });

  it('accepts a BOM-prefixed config file', () => {
    const { env, path } = makeHome();
    writeFileSync(path, `\uFEFF${JSON.stringify({ defaultEngine: 'agency', engines: { agency: { command: 'agency' } } }, null, 2)}`, 'utf-8');

    expect(loadConfig({ env })).toMatchObject({
      defaultEngine: 'agency',
      engines: { agency: { command: 'agency', args: [], env: {} } },
    });
    expect(readConfigFile({ env })).toMatchObject({
      defaultEngine: 'agency',
      engines: { agency: { command: 'agency', args: [], env: {} } },
    });
    expect(validateConfigFile({ env })).toMatchObject({ ok: true, path, problems: [] });
  });

  it('reports invalid JSON with file path, parse position, and expected shape', () => {
    const { env, path } = makeHome();
    writeFileSync(path, '{ nope', 'utf-8');

    expectConfigJsonError(() => loadConfig({ env }), path);
    expectConfigJsonError(() => readConfigFile({ env }), path);

    const validation = validateConfigFile({ env });
    expect(validation).toMatchObject({ ok: false, path });
    expect(validation.problems[0]).toContain(path);
    expect(validation.problems[0]).toMatch(/line \d+ column \d+ \(position \d+\)/);
    expect(validation.problems[0]).toContain('expected a JSON object matching the crontick config schema');
  });

  it('reports EOF-truncated JSON with end-of-input position and unfinished-construct hints', () => {
    const { env, path } = makeHome();
    const contents = '{ "defaultEngine": ';
    writeFileSync(path, contents, 'utf-8');

    expectConfigJsonError(() => loadConfig({ env }), path, ['Unexpected end of JSON input', "expected a value after ':'"]);
    expectConfigJsonError(() => readConfigFile({ env }), path, ['Unexpected end of JSON input', "expected a value after ':'"]);

    const validation = validateConfigFile({ env });
    expect(validation).toMatchObject({ ok: false, path });
    expect(validation.problems[0]).toContain(path);
    expect(validation.problems[0]).toContain('Unexpected end of JSON input');
    expect(validation.problems[0]).toContain("expected a value after ':'");
    expect(validation.problems[0]).toContain(`position ${contents.length}`);
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
    expect(client.removeConfigValue('engines.copilot.args')).toMatchObject({ engines: { copilot: { args: ['--allow-all-tools', '-p'] } } });
    expect(client.validateConfig()).toMatchObject({ ok: true, problems: [] });
  });


  it('redacts secret-like engine env values on config read helpers without mutating config.json', () => {
    const { env, path } = makeHome();
    const secret = `sk-proj-${'R'.repeat(28)}`;
    writeRawConfig(path, {
      defaultEngine: 'agency',
      engines: {
        agency: { command: 'agency', env: { OPENAI_API_KEY: secret } },
      },
    });
    const client = createClient({ env, startDaemon: false });

    expect(loadConfig({ env }).engines.agency.env.OPENAI_API_KEY).toBe(secret);
    expect(client.getConfig().engines.agency.env.OPENAI_API_KEY).toBe('[REDACTED]');
    expect(listEngines({ env })).toMatchObject({ agency: { env: { OPENAI_API_KEY: '[REDACTED]' } } });
    expect(validateConfigFile({ env })).toMatchObject({
      ok: true,
      config: { engines: { agency: { env: { OPENAI_API_KEY: '[REDACTED]' } } } },
    });
    expect(client.validateConfig()).toMatchObject({
      ok: true,
      config: { engines: { agency: { env: { OPENAI_API_KEY: '[REDACTED]' } } } },
    });
    expect(readFileSync(path, 'utf-8')).toContain(secret);
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

  it('retention.maxOutputBytesPerRun defaults to 2_000_000 and round-trips through get/set', () => {
    const { env, path } = makeHome();

    // No config file at all: built-in default applies.
    expect(loadConfig({ env }).retention.maxOutputBytesPerRun).toBe(2_000_000);

    // Custom config file that omits `retention` entirely: deep-merge keeps the default.
    writeRawConfig(path, { defaultEngine: 'copilot', engines: { copilot: { command: 'copilot' } } });
    expect(loadConfig({ env }).retention.maxOutputBytesPerRun).toBe(2_000_000);

    setConfigValue('retention.maxOutputBytesPerRun', 5_000_000, { env });
    expect(getConfigValue('retention.maxOutputBytesPerRun', { env })).toBe(5_000_000);

    expect(() => setConfigValue('retention.maxOutputBytesPerRun', 1023, { env }))
      .toThrow(/CONFIG_VALIDATION_ERROR|retention\.maxOutputBytesPerRun/);
    expect(() => setConfigValue('retention.maxOutputBytesPerRun', 1_000_000_001, { env }))
      .toThrow(/CONFIG_VALIDATION_ERROR|retention\.maxOutputBytesPerRun/);
    expect(() => setConfigValue('retention.maxOutputBytesPerRun', 1.5, { env }))
      .toThrow(/CONFIG_VALIDATION_ERROR|retention\.maxOutputBytesPerRun/);
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

  // Blocker 2 regression: `config unset` must genuinely remove the key from
  // config.json, not just report success while ConfigSchema's `.default(...)`
  // bakes the built-in value straight back into what gets persisted.
  describe('config unset genuinely removes keys from the persisted file (not baked back in)', () => {
    it('defaultEngine: unset removes the raw key even though the effective value (built-in default) is unchanged', () => {
      const { env, path } = makeHome();
      initConfig({ env }); // writes a full explicit file, including defaultEngine: "copilot"
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toHaveProperty('defaultEngine', 'copilot');

      removeConfigValue('defaultEngine', { env });

      // The raw file must no longer contain the key at all...
      expect(JSON.parse(readFileSync(path, 'utf-8'))).not.toHaveProperty('defaultEngine');
      // ...while the effective (merged) value still falls back to the built-in default.
      expect(getConfigValue('defaultEngine', { env })).toBe('copilot');
      expect(loadConfig({ env }).defaultEngine).toBe('copilot');
    });

    it('defaultEngine: unset after an explicit set truly falls back, and stays removed across repeat writes', () => {
      const { env, path } = makeHome();
      initConfig({ env });
      setConfigValue('defaultEngine', 'copilot', { env }); // re-affirm explicitly (same value, still baked into raw file)
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toHaveProperty('defaultEngine', 'copilot');

      removeConfigValue('defaultEngine', { env });
      expect(JSON.parse(readFileSync(path, 'utf-8'))).not.toHaveProperty('defaultEngine');

      // Writing an unrelated key afterward must not resurrect defaultEngine in the file.
      setConfigValue('retention.maxRunsPerJob', 42, { env });
      expect(JSON.parse(readFileSync(path, 'utf-8'))).not.toHaveProperty('defaultEngine');
      expect(getConfigValue('defaultEngine', { env })).toBe('copilot');
    });

    it('retention.*: unset removes the raw key, falling back to the built-in default effectively', () => {
      const { env, path } = makeHome();
      initConfig({ env });
      setConfigValue('retention.maxRunsPerJob', 250, { env });
      expect((JSON.parse(readFileSync(path, 'utf-8')) as { retention: { maxRunsPerJob: number } }).retention.maxRunsPerJob).toBe(250);

      removeConfigValue('retention.maxRunsPerJob', { env });

      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { retention?: { maxRunsPerJob?: number } };
      expect(raw.retention?.maxRunsPerJob).toBeUndefined();
      expect(getConfigValue('retention.maxRunsPerJob', { env })).toBe(100);
      expect(loadConfig({ env }).retention.maxRunsPerJob).toBe(100);
    });

    it('engines map: unsetting a customized built-in copilot field removes it from the file and falls back to the built-in value', () => {
      const { env, path } = makeHome();
      initConfig({ env });
      setConfigValue('engines.copilot.command', 'my-custom-copilot', { env });
      expect((JSON.parse(readFileSync(path, 'utf-8')) as { engines: { copilot: { command: string } } }).engines.copilot.command)
        .toBe('my-custom-copilot');

      removeConfigValue('engines.copilot.command', { env });

      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { engines: { copilot: Record<string, unknown> } };
      expect(raw.engines.copilot).not.toHaveProperty('command');
      expect(getConfigValue('engines.copilot.command', { env })).toBe('copilot');
    });

    it('config get with no path still reports full effective values (including inherited defaults) after unsetting', () => {
      const { env } = makeHome();
      initConfig({ env });
      removeConfigValue('defaultEngine', { env });
      removeConfigValue('retention.maxRunsPerJob', { env });

      expect(getConfigValue(undefined, { env })).toEqual({
        defaultEngine: 'copilot',
        engines: { copilot: { command: 'copilot', args: ['--allow-all-tools', '-p'], env: {} } },
        retention: { maxRunsPerJob: 100, maxOutputBytesPerRun: 2_000_000, maxLogFiles: 30 },
      });
    });
  });
});

