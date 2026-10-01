import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '../../src/client.js';
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
} from '../../src/config.js';
import { normalizeJobInput } from '../../src/job-input.js';
import { ConfigSchema } from '../../src/schemas/config.js';
import type { JobCreateInput } from '../../src/job-input.js';
import {
  DEFAULT_MAX_LOG_FILES,
  DEFAULT_MAX_OUTPUT_BYTES_PER_RUN,
  DEFAULT_RUN_RETENTION_CAP,
} from '../../src/constants/retention.js';

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
    alias: 'prompt-job',
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
  it('uses Claude as the sole built-in engine in both effective and schema defaults', () => {
    const { env } = makeHome();
    const expectedEngine = { command: 'claude', args: [], env: {}, type: 'claude' };
    expect(loadConfig({ env })).toMatchObject({ defaultEngine: 'claude', engines: { claude: expectedEngine } });
    expect(Object.keys(loadConfig({ env }).engines)).toEqual(['claude']);
    expect(ConfigSchema.parse({})).toMatchObject({ defaultEngine: 'claude', engines: { claude: expectedEngine } });
    expect(Object.keys(ConfigSchema.parse({}).engines)).toEqual(['claude']);
  });

  it('rejects the removed built-in name as default unless it is explicitly configured', () => {
    const { env, path } = makeHome();
    writeRawConfig(path, { defaultEngine: 'copilot' });
    expect(() => loadConfig({ env })).toThrow(/defaultEngine "copilot" must match a key in engines/);

    writeRawConfig(path, { defaultEngine: 'copilot', engines: { copilot: { command: 'custom' } } });
    expect(loadConfig({ env }).defaultEngine).toBe('copilot');
    expect(loadConfig({ env }).engines.copilot).toMatchObject({ command: 'custom', type: 'raw' });
  });

  it('uses built-in defaults when the config file is missing', () => {
    const { env, path } = makeHome();

    expect(loadConfig({ env })).toEqual({
      defaultEngine: 'claude',
      engines: { claude: { command: 'claude', args: [], env: {}, type: 'claude' } },
      retention: { maxRunsPerJob: DEFAULT_RUN_RETENTION_CAP, maxOutputBytesPerRun: DEFAULT_MAX_OUTPUT_BYTES_PER_RUN, maxLogFiles: DEFAULT_MAX_LOG_FILES },
      logging: { fileEnabled: true },
      defaults: { overlap: 'skip', retry: { max: 0, backoffSec: 30 } },
    });
    expect(validateConfigFile({ env })).toMatchObject({ ok: true, path, problems: [] });
  });

  it('deep-merges job defaults and preserves raw unset semantics', () => {
    const { env, path } = makeHome();
    writeRawConfig(path, { defaults: { overlap: 'queue', retry: { max: 2 } } });
    expect(loadConfig({ env }).defaults).toEqual({ overlap: 'queue', retry: { max: 2, backoffSec: 30 } });
    expect(getConfigValue('defaults.retry.backoffSec', { env })).toBe(30);

    setConfigValue('defaults.retry.backoffSec', 45, { env });
    expect(loadConfig({ env }).defaults.retry).toEqual({ max: 2, backoffSec: 45 });
    removeConfigValue('defaults.retry.backoffSec', { env });
    expect(JSON.parse(readFileSync(path, 'utf-8')).defaults.retry).toEqual({ max: 2 });
    expect(loadConfig({ env }).defaults.retry).toEqual({ max: 2, backoffSec: 30 });
  });

  it('rejects invalid job defaults in config.json', () => {
    const { env, path } = makeHome();
    writeRawConfig(path, { defaults: { timeoutSec: 0 } });
    expect(() => loadConfig({ env })).toThrow(/defaults.timeoutSec/);
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
        claude: { command: 'claude', args: [], env: {}, type: 'claude' },
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

  it('uses the built-in Claude adapter for a prompt without an explicit engine', () => {
    const { env } = makeHome();
    const result = buildPromptRunCommand({
      kind: 'prompt',
      prompt: 'do the thing',
      args: [],
      reuseSession: false,
    }, { env });
    expect(result.command).toBe('claude');
    expect(result.engine).toBe('claude');
    expect(result.args.slice(0, 5)).toEqual(['-p', 'do the thing', '--output-format', 'stream-json', '--verbose']);
    expect(result.args).toContain('--session-id');
  });

  it('supports client config CRUD', () => {
    const { env, path } = makeHome();
    const client = createClient({ env, startDaemon: false });

    expect(client.initConfig()).toMatchObject({ path, created: true });
    expect(readFileSync(path, 'utf-8')).toContain('"defaultEngine": "claude"');
    expect(client.addEngine('agency', { command: 'agency', args: ['cp'], env: { LOGS: 'XYZ' } })).toMatchObject({
      engines: { agency: { command: 'agency', args: ['cp'], env: { LOGS: 'XYZ' } } },
    });
    expect(client.listEngines()).toHaveProperty('agency.command', 'agency');
    expect(client.updateEngine('agency', { args: ['cp', '--logs-dir=XYZ'] })).toMatchObject({
      engines: { agency: { args: ['cp', '--logs-dir=XYZ'] } },
    });
    expect(client.setConfigValue('defaultEngine', 'agency')).toMatchObject({ defaultEngine: 'agency' });
    expect(client.getConfigValue('engines.agency.args')).toEqual(['cp', '--logs-dir=XYZ']);
    expect(client.setConfigValue('defaultEngine', 'claude')).toMatchObject({ defaultEngine: 'claude' });
    expect(client.removeEngine('agency')).not.toHaveProperty('engines.agency');
    expect(client.removeConfigValue('engines.claude.args')).toMatchObject({ engines: { claude: { args: [] } } });
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
    expect(loadConfig({ env }).retention.maxRunsPerJob).toBe(DEFAULT_RUN_RETENTION_CAP);

    // Custom config file that omits `retention` entirely: deep-merge keeps the default.
    writeRawConfig(path, { defaultEngine: 'copilot', engines: { copilot: { command: 'copilot' } } });
    expect(loadConfig({ env }).retention.maxRunsPerJob).toBe(DEFAULT_RUN_RETENTION_CAP);

    setConfigValue('retention.maxRunsPerJob', 250, { env });
    expect(getConfigValue('retention.maxRunsPerJob', { env })).toBe(250);

    expect(() => setConfigValue('retention.maxRunsPerJob', 0, { env })).toThrow(/CONFIG_VALIDATION_ERROR|retention\.maxRunsPerJob/);
    expect(() => setConfigValue('retention.maxRunsPerJob', 1.5, { env })).toThrow(/CONFIG_VALIDATION_ERROR|retention\.maxRunsPerJob/);
  });

  it('retention.maxOutputBytesPerRun defaults to 2_000_000 and round-trips through get/set', () => {
    const { env, path } = makeHome();

    // No config file at all: built-in default applies.
    expect(loadConfig({ env }).retention.maxOutputBytesPerRun).toBe(DEFAULT_MAX_OUTPUT_BYTES_PER_RUN);

    // Custom config file that omits `retention` entirely: deep-merge keeps the default.
    writeRawConfig(path, { defaultEngine: 'copilot', engines: { copilot: { command: 'copilot' } } });
    expect(loadConfig({ env }).retention.maxOutputBytesPerRun).toBe(DEFAULT_MAX_OUTPUT_BYTES_PER_RUN);

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
    writeConfigFile({ defaultEngine: 'claude', engines: { claude: { command: 'custom' } } }, { env });
    expect(loadConfig({ env }).engines.claude.command).toBe('custom');
    expect(initConfig({ env, force: true })).toMatchObject({ path, created: true });
    expect(loadConfig({ env }).engines.claude.command).toBe('claude');
  });

  // Blocker 2 regression: `config unset` must genuinely remove the key from
  // config.json, not just report success while ConfigSchema's `.default(...)`
  // bakes the built-in value straight back into what gets persisted.
  describe('config unset genuinely removes keys from the persisted file (not baked back in)', () => {
    it('defaultEngine: unset removes the raw key even though the effective value (built-in default) is unchanged', () => {
      const { env, path } = makeHome();
      initConfig({ env }); // writes a full explicit file, including defaultEngine: "claude"
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toHaveProperty('defaultEngine', 'claude');

      removeConfigValue('defaultEngine', { env });

      // The raw file must no longer contain the key at all...
      expect(JSON.parse(readFileSync(path, 'utf-8'))).not.toHaveProperty('defaultEngine');
      // ...while the effective (merged) value still falls back to the built-in default.
      expect(getConfigValue('defaultEngine', { env })).toBe('claude');
      expect(loadConfig({ env }).defaultEngine).toBe('claude');
    });

    it('defaultEngine: unset after an explicit set truly falls back, and stays removed across repeat writes', () => {
      const { env, path } = makeHome();
      initConfig({ env });
      setConfigValue('defaultEngine', 'claude', { env }); // re-affirm explicitly (same value, still baked into raw file)
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toHaveProperty('defaultEngine', 'claude');

      removeConfigValue('defaultEngine', { env });
      expect(JSON.parse(readFileSync(path, 'utf-8'))).not.toHaveProperty('defaultEngine');

      // Writing an unrelated key afterward must not resurrect defaultEngine in the file.
      setConfigValue('retention.maxRunsPerJob', 42, { env });
      expect(JSON.parse(readFileSync(path, 'utf-8'))).not.toHaveProperty('defaultEngine');
      expect(getConfigValue('defaultEngine', { env })).toBe('claude');
    });

    it('retention.*: unset removes the raw key, falling back to the built-in default effectively', () => {
      const { env, path } = makeHome();
      initConfig({ env });
      setConfigValue('retention.maxRunsPerJob', 250, { env });
      expect((JSON.parse(readFileSync(path, 'utf-8')) as { retention: { maxRunsPerJob: number } }).retention.maxRunsPerJob).toBe(250);

      removeConfigValue('retention.maxRunsPerJob', { env });

      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { retention?: { maxRunsPerJob?: number } };
      expect(raw.retention?.maxRunsPerJob).toBeUndefined();
      expect(getConfigValue('retention.maxRunsPerJob', { env })).toBe(DEFAULT_RUN_RETENTION_CAP);
      expect(loadConfig({ env }).retention.maxRunsPerJob).toBe(DEFAULT_RUN_RETENTION_CAP);
    });

    it('engines map: unsetting a customized built-in Claude field removes it from the file and falls back to the built-in value', () => {
      const { env, path } = makeHome();
      initConfig({ env });
      setConfigValue('engines.claude.command', 'my-custom-claude', { env });
      expect((JSON.parse(readFileSync(path, 'utf-8')) as { engines: { claude: { command: string } } }).engines.claude.command)
        .toBe('my-custom-claude');

      removeConfigValue('engines.claude.command', { env });

      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { engines: { claude: Record<string, unknown> } };
      expect(raw.engines.claude).not.toHaveProperty('command');
      expect(getConfigValue('engines.claude.command', { env })).toBe('claude');
    });

    it('config get with no path still reports full effective values (including inherited defaults) after unsetting', () => {
      const { env } = makeHome();
      initConfig({ env });
      removeConfigValue('defaultEngine', { env });
      removeConfigValue('retention.maxRunsPerJob', { env });

      expect(getConfigValue(undefined, { env })).toEqual({
        defaultEngine: 'claude',
        engines: { claude: { command: 'claude', args: [], env: {}, type: 'claude' } },
        retention: { maxRunsPerJob: DEFAULT_RUN_RETENTION_CAP, maxOutputBytesPerRun: DEFAULT_MAX_OUTPUT_BYTES_PER_RUN, maxLogFiles: DEFAULT_MAX_LOG_FILES },
        logging: { fileEnabled: true },
        defaults: { overlap: 'skip', retry: { max: 0, backoffSec: 30 } },
      });
    });
  });
});
