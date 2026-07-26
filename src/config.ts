/**
 * Configuration management for crontick. Handles `config.json` read/write, engine
 * CRUD, and config key-path operations. The built-in default config provides the
 * `copilot` engine; file config is deep-merged over it.
 *
 * Precedence for engine resolution: file config > BUILT_IN_CONFIG.
 * Writes use atomic rename (write-to-tmp, rename) for crash safety.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { CrontickError } from './errors.js';
import { configPath as defaultConfigPath, ensureDirs } from './paths.js';
import {
  ConfigKeySchema,
  ConfigSchema,
  EngineConfigSchema,
  PersistedConfigSchema,
  RetentionConfigSchema,
  type CrontickConfig,
  type EngineConfig,
  type PersistedConfig,
  type RetentionConfig,
} from './schemas/config.js';
import type { PromptAction } from './schemas/job.js';
import { nullLogger, type Logger } from './logger.js';

export { ConfigSchema, EngineConfigSchema, RetentionConfigSchema, type CrontickConfig, type EngineConfig, type RetentionConfig };

export interface ConfigOptions {
  env?: NodeJS.ProcessEnv;
  path?: string;
  logger?: Logger;
}

export interface InitConfigOptions extends ConfigOptions {
  force?: boolean;
}

export interface ConfigValidationResult {
  ok: boolean;
  path: string;
  config?: CrontickConfig;
  problems: string[];
}

export interface PromptRunCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  engine: string;
}

/** Built-in fallback config used when no file exists; also serves as the merge base. */
export const BUILT_IN_CONFIG: CrontickConfig = Object.freeze({
  defaultEngine: 'copilot',
  engines: {
    copilot: Object.freeze({ command: 'copilot', args: [], env: {} }),
  },
  retention: Object.freeze({ maxRunsPerJob: 100, maxOutputBytesPerRun: 2_000_000, maxLogFiles: 30 }),
});

/** Resolves config file path: explicit `options.path` > `<dataDir>/config.json`. */
export function configFilePath(options: ConfigOptions = {}): string {
  return options.path ? resolve(options.path) : defaultConfigPath(options.env);
}

/** Loads config: reads file and deep-merges over BUILT_IN_CONFIG. Returns built-in if no file. */
export function loadConfig(options: ConfigOptions = {}): CrontickConfig {
  const filePath = configFilePath(options);
  const logger = (options.logger ?? nullLogger).child('config');
  if (!existsSync(filePath)) {
    logger.debug('Config file missing; using built-in defaults', { path: filePath, keys: Object.keys(BUILT_IN_CONFIG) });
    return cloneConfig(BUILT_IN_CONFIG);
  }
  logger.debug('Reading config file', { path: filePath });
  const raw = readConfigJson(filePath);
  const config = parseConfig(raw, filePath);
  logger.debug('Loaded config', { path: filePath, keys: Object.keys(config), engines: Object.keys(config.engines) });
  return config;
}

export function readConfigFile(options: ConfigOptions = {}): CrontickConfig | null {
  const filePath = configFilePath(options);
  const logger = (options.logger ?? nullLogger).child('config');
  if (!existsSync(filePath)) {
    logger.debug('Config file does not exist', { path: filePath });
    return null;
  }
  logger.debug('Reading config file', { path: filePath });
  return parseConfig(readConfigJson(filePath), filePath);
}

export function writeConfigFile(config: unknown, options: ConfigOptions = {}): CrontickConfig {
  const filePath = configFilePath(options);
  const parsed = parseConfig(config, filePath);
  writeJsonAtomic(filePath, parsed, options.env);
  (options.logger ?? nullLogger).child('config').debug('Wrote config file', { path: filePath, keys: Object.keys(parsed), engines: Object.keys(parsed.engines) });
  return parsed;
}

export function initConfig(options: InitConfigOptions = {}): { path: string; config: CrontickConfig; created: boolean } {
  const filePath = configFilePath(options);
  if (existsSync(filePath) && !options.force) {
    throw new CrontickError(
      'CONFIG_EXISTS',
      `Config file already exists at ${filePath}. Use --force to replace it, or edit that file directly.`,
      { path: filePath },
    );
  }
  const config = cloneConfig(BUILT_IN_CONFIG);
  writeJsonAtomic(filePath, config, options.env);
  (options.logger ?? nullLogger).child('config').debug('Initialized config file', { path: filePath, force: options.force === true });
  return { path: filePath, config, created: true };
}

export function validateConfigFile(options: ConfigOptions = {}): ConfigValidationResult {
  const filePath = configFilePath(options);
  const logger = (options.logger ?? nullLogger).child('config');
  logger.debug('Validating config file', { path: filePath });
  if (!existsSync(filePath)) {
    return { ok: true, path: filePath, config: cloneConfig(BUILT_IN_CONFIG), problems: [] };
  }
  try {
    const config = parseConfig(readConfigJson(filePath), filePath);
    return { ok: true, path: filePath, config, problems: [] };
  } catch (err) {
    return {
      ok: false,
      path: filePath,
      problems: err instanceof CrontickError ? [err.message] : [errorMessage(err)],
    };
  }
}

export function getConfigValue(path: string | undefined, options: ConfigOptions = {}): unknown {
  const config = loadConfig(options);
  if (!path) return config;
  return readPath(config, parseKeyPath(path));
}

export function setConfigValue(path: string, value: unknown, options: ConfigOptions = {}): CrontickConfig {
  const keyPath = parseKeyPath(path);
  const updated = cloneRaw(readRawStoredConfig(options));
  writePath(updated as unknown as Record<string, unknown>, keyPath, value);
  return persistRawConfig(updated, options);
}

export function removeConfigValue(path: string, options: ConfigOptions = {}): CrontickConfig {
  const keyPath = parseKeyPath(path);
  const updated = cloneRaw(readRawStoredConfig(options));
  removePath(updated as unknown as Record<string, unknown>, keyPath);
  return persistRawConfig(updated, options);
}

export function listEngines(options: ConfigOptions = {}): Record<string, EngineConfig> {
  return loadConfig(options).engines;
}

export function addEngine(name: string, engine: unknown, options: ConfigOptions = {}): CrontickConfig {
  return setEngine(name, engine, false, options);
}

export function updateEngine(name: string, engine: unknown, options: ConfigOptions = {}): CrontickConfig {
  return setEngine(name, engine, true, options);
}

export function removeEngine(name: string, options: ConfigOptions = {}): CrontickConfig {
  const key = parseEngineName(name);
  const effective = loadConfig(options);
  if (!Object.prototype.hasOwnProperty.call(effective.engines, key)) {
    throw new CrontickError(
      'CONFIG_ENGINE_NOT_FOUND',
      `Engine "${key}" is not defined in ${configFilePath(options)}. Choose an existing engine or add it first.`,
      { path: configFilePath(options), key: `engines.${key}` },
    );
  }
  if (effective.defaultEngine === key) {
    throw new CrontickError(
      'CONFIG_VALIDATION_ERROR',
      `Cannot remove default engine "${key}" from ${configFilePath(options)}. Set defaultEngine to another engine first, then remove "${key}".`,
      { path: configFilePath(options), key: 'defaultEngine' },
    );
  }
  if (Object.prototype.hasOwnProperty.call(BUILT_IN_CONFIG.engines, key)) {
    throw new CrontickError(
      'CONFIG_BUILTIN_ENGINE',
      `Engine "${key}" is a built-in fallback engine and cannot be removed from the effective config. Change defaultEngine or update engines.${key}.command/args instead.`,
      { path: configFilePath(options), key: `engines.${key}` },
    );
  }
  const updated = cloneRaw(readRawStoredConfig(options));
  const engines = updated.engines;
  if (isRecord(engines) && Object.prototype.hasOwnProperty.call(engines, key)) {
    delete engines[key];
  }
  return persistRawConfig(updated, options);
}

/**
 * Builds the full command+args for executing a prompt action via its engine.
 * Merges engine-level args, the prompt text, job-level args, and optional sessionId.
 */
export function buildPromptRunCommand(action: PromptAction, options: ConfigOptions = {}): PromptRunCommand {
  const logger = (options.logger ?? nullLogger).child('config');
  const config = loadConfig(options);
  const engineName = action.engine ?? config.defaultEngine;
  const engine = config.engines[engineName];
  if (!engine) {
    throw new CrontickError(
      'CONFIG_ENGINE_NOT_FOUND',
      `Prompt job requested engine "${engineName}", but ${configFilePath(options)} does not define engines.${engineName}. Add that engine to the config or change the job/default engine.`,
      { path: configFilePath(options), key: `engines.${engineName}` },
    );
  }
  const args = [
    ...(engine.args ?? []),
    action.prompt,
    ...(action.args ?? []),
  ];
  if (action.sessionId) args.push(`--session-id=${action.sessionId}`);
  const result = {
    command: engine.command,
    args,
    env: { ...(engine.env ?? {}) },
    engine: engineName,
  };
  logger.debug('Resolved prompt engine command', {
    path: configFilePath(options),
    engine: engineName,
    command: result.command,
    args: result.args,
    envKeys: Object.keys(result.env),
  });
  return result;
}

function setEngine(name: string, engine: unknown, mustExist: boolean, options: ConfigOptions): CrontickConfig {
  const key = parseEngineName(name);
  const effective = loadConfig(options);
  const existing = effective.engines[key];
  if (mustExist && !existing) {
    throw new CrontickError(
      'CONFIG_ENGINE_NOT_FOUND',
      `Engine "${key}" is not defined in ${configFilePath(options)}. Add it first or choose an existing engine.`,
      { path: configFilePath(options), key: `engines.${key}` },
    );
  }
  if (!mustExist && existing) {
    throw new CrontickError(
      'CONFIG_ENGINE_EXISTS',
      `Engine "${key}" already exists in ${configFilePath(options)}. Use update if you want to change it.`,
      { path: configFilePath(options), key: `engines.${key}` },
    );
  }
  const parsed = EngineConfigSchema.safeParse({ ...(mustExist ? existing : {}), ...(isRecord(engine) ? engine : {}) });
  if (!parsed.success) throw configValidationError(configFilePath(options), parsed.error);
  const updated = cloneRaw(readRawStoredConfig(options));
  if (!isRecord(updated.engines)) updated.engines = {};
  (updated.engines as Record<string, unknown>)[key] = parsed.data;
  return persistRawConfig(updated, options);
}

/** Deep-merges file config over BUILT_IN_CONFIG then validates via ConfigSchema. */
function parseConfig(input: unknown, filePath: string): CrontickConfig {
  const merged = deepMerge(cloneConfig(BUILT_IN_CONFIG), input);
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) throw configValidationError(filePath, parsed.error);
  return parsed.data;
}

function readConfigJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new CrontickError(
      'CONFIG_READ_ERROR',
      `Failed to read config file ${filePath}: ${errorMessage(err)}. Fix the JSON syntax or run "crontick config init --force" to recreate the default config.`,
      { path: filePath },
    );
  }
}

function configValidationError(filePath: string, error: z.ZodError): CrontickError {
  const first = error.issues[0];
  const unknownKeys = first && 'keys' in first && Array.isArray(first.keys) ? first.keys : undefined;
  const key = first?.path.length ? first.path.join('.') : unknownKeys?.[0] ? String(unknownKeys[0]) : '<root>';
  const expected = first?.message ?? 'valid crontick config';
  return new CrontickError(
    'CONFIG_VALIDATION_ERROR',
    `Invalid config file ${filePath} at ${key}: ${expected}. Edit ${filePath} so ${key} matches the documented config schema, or run "crontick config init --force" to recreate defaults.`,
    { path: filePath, key, issues: error.issues },
  );
}

/** Atomic write: tmp file with restrictive mode (0o600), then rename into place. */
function writeJsonAtomic(filePath: string, config: unknown, env?: NodeJS.ProcessEnv): void {
  ensureDirs(env);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmpPath, filePath);
}

/**
 * Reads exactly what's explicitly stored in config.json — no BUILT_IN_CONFIG
 * merge, no schema `.default(...)` applied. Returns `{}` when the file
 * doesn't exist. This (not `loadConfig`) is the base every write operation
 * (`setConfigValue`, `removeConfigValue`, engine CRUD) must clone and mutate,
 * so that a key which was never explicitly set — or one that's just been
 * removed — stays absent from the file instead of being re-baked in from
 * BUILT_IN_CONFIG/schema defaults on the next write.
 */
function readRawStoredConfig(options: ConfigOptions): PersistedConfig {
  const filePath = configFilePath(options);
  if (!existsSync(filePath)) return {};
  const parsed = PersistedConfigSchema.safeParse(readConfigJson(filePath));
  if (!parsed.success) throw configValidationError(filePath, parsed.error);
  return parsed.data;
}

/**
 * Validates a raw (possibly partial) config by computing its effective value
 * (merged over BUILT_IN_CONFIG, checked against the full refined
 * `ConfigSchema`) — but persists the raw object as-is, unmerged. Returns the
 * effective config so callers keep returning fully-resolved values.
 */
function persistRawConfig(raw: PersistedConfig, options: ConfigOptions): CrontickConfig {
  const filePath = configFilePath(options);
  const effective = parseConfig(raw, filePath);
  writeJsonAtomic(filePath, raw, options.env);
  (options.logger ?? nullLogger).child('config').debug('Wrote config file', { path: filePath, keys: Object.keys(raw) });
  return effective;
}

function cloneRaw(raw: PersistedConfig): PersistedConfig {
  return JSON.parse(JSON.stringify(raw)) as PersistedConfig;
}

function parseKeyPath(path: string): string[] {
  const parsed = ConfigKeySchema.safeParse(path);
  if (!parsed.success) {
    throw new CrontickError(
      'CONFIG_KEY_ERROR',
      `Invalid config key path "${path}". Use dot-separated keys such as defaultEngine or engines.copilot.command.`,
      { key: path },
    );
  }
  return path.split('.').filter(Boolean);
}

function parseEngineName(name: string): string {
  const parsed = ConfigKeySchema.safeParse(name);
  if (!parsed.success) {
    throw new CrontickError(
      'CONFIG_KEY_ERROR',
      `Invalid engine name "${name}". Use letters, numbers, underscore, dash, or dot.`,
      { key: name },
    );
  }
  return name;
}

function readPath(config: CrontickConfig, keyPath: string[]): unknown {
  let current: unknown = config;
  for (const key of keyPath) {
    if (!isRecord(current) || !(key in current)) {
      throw new CrontickError(
        'CONFIG_KEY_NOT_FOUND',
        `Config key "${keyPath.join('.')}" was not found. Run "crontick config get" to inspect available keys.`,
        { key: keyPath.join('.') },
      );
    }
    current = current[key];
  }
  return current;
}

function writePath(target: Record<string, unknown>, keyPath: string[], value: unknown): void {
  if (keyPath.length === 0) throw new CrontickError('CONFIG_KEY_ERROR', 'Config key path cannot be empty');
  let current = target;
  for (const key of keyPath.slice(0, -1)) {
    const next = current[key];
    if (!isRecord(next)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keyPath[keyPath.length - 1]] = value;
}

function removePath(target: Record<string, unknown>, keyPath: string[]): void {
  if (keyPath.length === 0) throw new CrontickError('CONFIG_KEY_ERROR', 'Config key path cannot be empty');
  let current: unknown = target;
  for (const key of keyPath.slice(0, -1)) {
    if (!isRecord(current) || !(key in current)) {
      throw new CrontickError(
        'CONFIG_KEY_NOT_FOUND',
        `Config key "${keyPath.join('.')}" was not found. Run "crontick config get" to inspect available keys.`,
        { key: keyPath.join('.') },
      );
    }
    current = current[key];
  }
  if (!isRecord(current) || !(keyPath[keyPath.length - 1] in current)) {
    throw new CrontickError(
      'CONFIG_KEY_NOT_FOUND',
      `Config key "${keyPath.join('.')}" was not found. Run "crontick config get" to inspect available keys.`,
      { key: keyPath.join('.') },
    );
  }
  delete current[keyPath[keyPath.length - 1]];
}

function deepMerge(base: CrontickConfig, override: unknown): unknown {
  if (!isRecord(override)) return base;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isRecord(value) && isRecord(result[key])) {
      result[key] = deepMerge(result[key] as CrontickConfig, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function cloneConfig(config: CrontickConfig): CrontickConfig {
  return JSON.parse(JSON.stringify(config)) as CrontickConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
