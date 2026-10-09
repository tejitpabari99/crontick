/**
 * Configuration management for crontick. Handles `config.json` read/write, engine
 * CRUD, and config key-path operations. The built-in default config provides the
 * `claude` engine; file config is deep-merged over it.
 *
 * Precedence for engine resolution: file config > BUILT_IN_CONFIG.
 * Writes use atomic rename (write-to-tmp, rename) for crash safety.
 */
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { CrontickError } from './errors.js';
import { configPath as defaultConfigPath, ensureDirs, pidFilePath } from './paths.js';
import { isProcessAlive } from './process-liveness.js';
import { sleep } from './utils/sleep.js';
import {
  CONFIG_EDIT_NOTICE,
  CONFIG_LOCK_RETRY_MS,
  CONFIG_LOCK_STALE_MS,
  CONFIG_LOCK_TIMEOUT_MS,
  CONFIG_REDACTED_MARKER,
  CONFIG_RENAME_RETRIES,
  CONFIG_RENAME_RETRY_MS,
  CONFIG_REVISION_ABSENT,
} from './constants/config.js';
import { readJsonFile } from './json-file.js';
import { DEFAULT_MAX_CONSECUTIVE_FAILURES } from './constants/daemon.js';
import {
  DEFAULT_MAX_LOG_FILES,
  DEFAULT_MAX_OUTPUT_BYTES_PER_RUN,
  DEFAULT_RUN_RETENTION_CAP,
} from './constants/retention.js';
import {
  ConfigKeySchema,
  ConfigSchema,
  EngineConfigSchema,
  LoggingConfigSchema,
  PersistedConfigSchema,
  RetentionConfigSchema,
  type CrontickConfig,
  type EngineConfig,
  type LoggingConfig,
  type PersistedConfig,
  type RetentionConfig,
} from './schemas/config.js';
import type { PromptAction } from './schemas/job.js';
import { nullLogger, redactValue, type Logger } from './logger.js';
import { getEngineAdapter } from './engines/registry.js';
import type { EngineOptions } from './engines/types.js';

export { ConfigSchema, EngineConfigSchema, LoggingConfigSchema, RetentionConfigSchema, type CrontickConfig, type EngineConfig, type LoggingConfig, type RetentionConfig };

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
  sessionId?: string;
}

/** Internal execution bundle: invocation and parser share one config read. */
export interface ResolvedPromptRunCommand {
  invocation: PromptRunCommand;
  adapter: ReturnType<typeof getEngineAdapter>;
  engineOptions: EngineOptions;
}

/** Built-in fallback config used when no file exists; also serves as the merge base. */
export const BUILT_IN_CONFIG: CrontickConfig = Object.freeze({
  defaultEngine: 'claude',
  engines: {
    claude: Object.freeze({ command: 'claude', args: [], env: {}, type: 'claude' }),
  },
  retention: Object.freeze({
    maxRunsPerJob: DEFAULT_RUN_RETENTION_CAP,
    maxOutputBytesPerRun: DEFAULT_MAX_OUTPUT_BYTES_PER_RUN,
    maxLogFiles: DEFAULT_MAX_LOG_FILES,
  }),
  logging: Object.freeze({ fileEnabled: true }),
  daemon: Object.freeze({}),
  maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
  defaults: Object.freeze({ overlap: 'skip', retry: Object.freeze({ max: 0, backoffSec: 30 }), timeoutSec: undefined }),
});

export function redactConfigForRead(config: CrontickConfig): CrontickConfig {
  return redactValue(config) as CrontickConfig;
}

/** Read-side redaction for the raw stored (sparse) config shape. */
export function redactStoredConfigForRead(stored: PersistedConfig): PersistedConfig {
  return redactValue(stored) as PersistedConfig;
}

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
  const config = defaultConfigTemplate();
  writeJsonAtomic(filePath, config, options.env);
  (options.logger ?? nullLogger).child('config').debug('Initialized config file', { path: filePath, force: options.force === true });
  return { path: filePath, config, created: true };
}

/** The full, explicit built-in config as written to a fresh config.json (`timeoutSec` is omitted: unset). */
export function defaultConfigTemplate(): CrontickConfig {
  return cloneConfig(BUILT_IN_CONFIG);
}

/**
 * Creates `<dataDir>/config.json` with the full default config when it does not
 * exist yet; an existing file (hand-edited or not) is never read, merged or
 * touched. The content is written to a temp file and published with a hard link,
 * which is both atomic (readers never see a partial file) and exclusive (EEXIST
 * when another process won the race). Filesystems without hard links fall back
 * to an exclusive `wx` write.
 */
export function ensureConfigFile(options: ConfigOptions = {}): { path: string; created: boolean } {
  const filePath = configFilePath(options);
  if (existsSync(filePath)) return { path: filePath, created: false };
  ensureDirs(options.env);
  mkdirSync(dirname(filePath), { recursive: true });
  const content = `${JSON.stringify(defaultConfigTemplate(), null, 2)}\n`;
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
  try {
    linkSync(tmpPath, filePath);
    return { path: filePath, created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { path: filePath, created: false };
    try {
      writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
      return { path: filePath, created: true };
    } catch (fallbackErr) {
      if ((fallbackErr as NodeJS.ErrnoException).code === 'EEXIST') return { path: filePath, created: false };
      throw fallbackErr;
    }
  } finally {
    try { unlinkSync(tmpPath); } catch { /* best-effort temp cleanup */ }
  }
}

export function validateConfigFile(options: ConfigOptions = {}): ConfigValidationResult {
  const filePath = configFilePath(options);
  const logger = (options.logger ?? nullLogger).child('config');
  logger.debug('Validating config file', { path: filePath });
  if (!existsSync(filePath)) {
    return { ok: true, path: filePath, config: redactConfigForRead(cloneConfig(BUILT_IN_CONFIG)), problems: [] };
  }
  try {
    const config = parseConfig(readConfigJson(filePath), filePath);
    return { ok: true, path: filePath, config: redactConfigForRead(config), problems: [] };
  } catch (err) {
    return {
      ok: false,
      path: filePath,
      problems: err instanceof CrontickError ? [err.message] : [errorMessage(err)],
    };
  }
}

export function getConfigValue(path: string | undefined, options: ConfigOptions = {}): unknown {
  const config = redactConfigForRead(loadConfig(options));
  const keyPath = path ? parseKeyPath(path) : undefined;
  return keyPath ? readPath(config, keyPath) : config;
}

export function setConfigValue(path: string, value: unknown, options: ConfigOptions = {}): CrontickConfig {
  const keyPath = parseKeyPath(path);
  const updated = cloneRaw(readRawStoredConfig(options));
  writePath(updated as unknown as Record<string, unknown>, keyPath, value);
  return redactConfigForRead(persistRawConfig(updated, options));
}

export function removeConfigValue(path: string, options: ConfigOptions = {}): CrontickConfig {
  const keyPath = parseKeyPath(path);
  const updated = cloneRaw(readRawStoredConfig(options));
  removePath(updated as unknown as Record<string, unknown>, keyPath);
  return redactConfigForRead(persistRawConfig(updated, options));
}

export function listEngines(options: ConfigOptions = {}): Record<string, EngineConfig> {
  return redactConfigForRead(loadConfig(options)).engines;
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
  return redactConfigForRead(persistRawConfig(updated, options));
}

/**
 * Builds the full command+args for executing a prompt action via its engine.
 * Merges engine-level args, the prompt text, job-level args, and optional sessionId.
 */
export function buildPromptRunCommand(
  action: PromptAction,
  options: ConfigOptions = {},
  context: Partial<Pick<EngineOptions, 'runId' | 'jobId' | 'dataDir'>> = {},
): PromptRunCommand {
  return resolvePromptRunCommand(action, options, context).invocation;
}

/** Resolves the invocation and its adapter from a single engine config snapshot. */
export function resolvePromptRunCommand(
  action: PromptAction,
  options: ConfigOptions = {},
  context: Partial<Pick<EngineOptions, 'runId' | 'jobId' | 'dataDir'>> = {},
): ResolvedPromptRunCommand {
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
  const adapter = getEngineAdapter(engine.type);
  const engineOptions: EngineOptions = {
    command: engine.command,
    engineArgs: engine.args ?? [],
    runId: context.runId ?? '',
    jobId: context.jobId ?? '',
    dataDir: context.dataDir ?? '',
    sessionId: action.sessionId,
    reuseSession: action.reuseSession,
    args: action.args ?? [],
    env: engine.env ?? {},
  };
  const invocation = adapter.buildInvocation(action.prompt, engineOptions);
  if (invocation.sessionId) engineOptions.sessionId = invocation.sessionId;
  const result = {
    ...invocation,
    engine: engineName,
  };
  logger.debug('Resolved prompt engine command', {
    path: configFilePath(options),
    engine: engineName,
    command: result.command,
    args: result.args,
    envKeys: Object.keys(result.env),
  });
  return { invocation: result, adapter, engineOptions };
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
  return redactConfigForRead(persistRawConfig(updated, options));
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
    return readJsonFile(filePath, {
      errorCode: 'CONFIG_READ_ERROR',
      subject: 'config file',
      expectedShape: 'expected a JSON object matching the crontick config schema',
    });
  } catch (err) {
    if (err instanceof CrontickError && err.code === 'CONFIG_READ_ERROR') {
      throw new CrontickError(
        err.code,
        `${err.message}. Fix the JSON syntax by editing the file by hand.`,
        err.details,
      );
    }
    throw err;
  }
}

function configValidationError(filePath: string, error: z.ZodError): CrontickError {
  const first = error.issues[0];
  const unknownKeys = first && 'keys' in first && Array.isArray(first.keys) ? first.keys : undefined;
  const key = first?.path.length ? first.path.join('.') : unknownKeys?.[0] ? String(unknownKeys[0]) : '<root>';
  const expected = first?.message ?? 'valid crontick config';
  return new CrontickError(
    'CONFIG_VALIDATION_ERROR',
    `Invalid config file ${filePath} at ${key}: ${expected}. Edit ${filePath} so ${key} matches the documented config schema.`,
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
      `Invalid config key path "${path}". Use dot-separated keys such as defaultEngine or engines.claude.command.`,
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

// ---------------------------------------------------------------------------
// Config write core: the single mutator shared by every surface.
// ---------------------------------------------------------------------------

export type ConfigOp =
  | { op: 'set'; key: string; value: unknown }
  | { op: 'unset'; key: string };

export interface ApplyOpsOptions extends ConfigOptions {
  /** Reject with CONFIG_CONFLICT unless the file's current revision equals this. */
  ifRevision?: string;
  /** Injectable daemon-liveness probe (default: live pid in daemon.pid). The API route passes `() => true`. */
  daemonRunning?: () => boolean;
  /** Validate everything (revision, key guard, schema) but skip the write; result reflects the would-be state. */
  dryRun?: boolean;
  /** Lock acquisition timeout in ms (default 2000). */
  lockTimeoutMs?: number;
  /** Age in ms after which an existing lock is broken (default 10000). */
  lockStaleMs?: number;
}

export interface ApplyOpsResult {
  path: string;
  /** Effective config, redacted. */
  config: CrontickConfig;
  /** Raw stored keys, redacted. */
  stored: PersistedConfig;
  /** Op keys whose stored value actually changed. */
  changed: string[];
  revision: string;
  notice: string;
}

/** sha256 of the config file bytes, or `absent` when there is no file. */
export function getConfigRevision(options: ConfigOptions = {}): string {
  const filePath = configFilePath(options);
  if (!existsSync(filePath)) return CONFIG_REVISION_ABSENT;
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** True when `daemon.pid` names a live process. */
export function isDaemonProcessRunning(env?: NodeJS.ProcessEnv): boolean {
  try {
    const pid = Number.parseInt(readFileSync(pidFilePath(env), 'utf-8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 && isProcessAlive(pid);
  } catch {
    return false;
  }
}

/**
 * Applies set/unset ops in one locked, validated, atomic write:
 * lock -> read raw -> revision check -> daemon-key guard -> unredact -> apply on clone ->
 * validate effective config -> tmp+rename -> unlock. Nothing is written on any error.
 */
export async function applyOps(ops: ConfigOp[], options: ApplyOpsOptions = {}): Promise<ApplyOpsResult> {
  const filePath = configFilePath(options);
  // Fail fast on malformed ops before touching the lock.
  const parsedOps = ops.map((op) => ({ op, keyPath: parseKeyPath(op.key) }));
  const release = await acquireConfigLock(filePath, options);
  try {
    const exists = existsSync(filePath);
    const currentRevision = getConfigRevision(options);
    if (options.ifRevision !== undefined && options.ifRevision !== currentRevision) {
      throw new CrontickError(
        'CONFIG_CONFLICT',
        `Config file ${filePath} changed since it was read (revision ${currentRevision}). Reload it and retry.`,
        { path: filePath, revision: currentRevision, ifRevision: options.ifRevision },
      );
    }
    // Refuse on an already-invalid file (unparsable, schema-invalid, or effective-invalid).
    const stored = exists ? readStoredStrict(filePath) : ({} as PersistedConfig);
    parseConfig(stored, filePath);

    const daemonUp = parsedOps.some(({ keyPath }) => keyPath[0] === 'daemon')
      && (options.daemonRunning ?? (() => isDaemonProcessRunning(options.env)))();
    const updated = cloneRaw(stored);
    const changed: string[] = [];
    for (const { op, keyPath } of parsedOps) {
      if (keyPath[0] === 'daemon' && daemonUp) {
        throw new CrontickError(
          'CONFIG_KEY_READ_ONLY',
          `${op.key} can only be changed while the daemon is stopped: run "crontick daemon stop" first`,
          { key: op.key },
        );
      }
      const before = JSON.stringify(peekPath(updated, keyPath));
      if (op.op === 'set') {
        const value = unredact(op.value, peekPath(updated, keyPath), keyPath[keyPath.length - 1], op.key);
        writePath(updated as unknown as Record<string, unknown>, keyPath, value);
      } else {
        removePath(updated as unknown as Record<string, unknown>, keyPath);
      }
      if (before !== JSON.stringify(peekPath(updated, keyPath)) && !changed.includes(op.key)) changed.push(op.key);
    }

    const persisted = PersistedConfigSchema.safeParse(updated);
    if (!persisted.success) throw configValidationError(filePath, persisted.error);
    const effective = parseConfig(updated, filePath);

    const content = `${JSON.stringify(updated, null, 2)}\n`;
    if (options.dryRun) {
      return {
        path: filePath,
        config: redactConfigForRead(effective),
        stored: redactStoredConfigForRead(updated),
        changed,
        revision: currentRevision,
        notice: CONFIG_EDIT_NOTICE,
      };
    }
    await writeConfigAtomic(filePath, content, options.env);
    return {
      path: filePath,
      config: redactConfigForRead(effective),
      stored: redactStoredConfigForRead(updated),
      changed,
      revision: createHash('sha256').update(content).digest('hex'),
      notice: CONFIG_EDIT_NOTICE,
    };
  } finally {
    release();
  }
}

/** Raw stored (sparse) config as on disk; `{}` when there is no file. Throws on an invalid file. */
export function readStoredConfigFile(options: ConfigOptions = {}): PersistedConfig {
  const filePath = configFilePath(options);
  return existsSync(filePath) ? readStoredStrict(filePath) : ({} as PersistedConfig);
}

function readStoredStrict(filePath: string): PersistedConfig {
  const parsed = PersistedConfigSchema.safeParse(readConfigJson(filePath));
  if (!parsed.success) throw configValidationError(filePath, parsed.error);
  return parsed.data;
}

function peekPath(target: unknown, keyPath: string[]): unknown {
  let current = target;
  for (const key of keyPath) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Restores stored secrets from echoed redacted values. A submitted string equal to the
 * redacted form of the stored value at the same path/index is replaced by the stored value;
 * any other string containing the redaction marker is rejected.
 */
function unredact(submitted: unknown, stored: unknown, keyHint: string | undefined, fullKey: string): unknown {
  if (typeof submitted === 'string') {
    if (typeof stored === 'string') {
      if (submitted === stored) return stored;
      if (submitted === redactValue(stored, keyHint)) return stored;
    }
    if (submitted.includes(CONFIG_REDACTED_MARKER)) {
      throw new CrontickError(
        'CONFIG_REDACTED_VALUE',
        `Value for ${fullKey} contains the redaction marker "${CONFIG_REDACTED_MARKER}" but does not match a stored secret. Submit the real value instead.`,
        { key: fullKey },
      );
    }
    return submitted;
  }
  if (Array.isArray(submitted)) {
    const storedArr = Array.isArray(stored) ? stored : [];
    return submitted.map((item, i) => unredact(item, storedArr[i], undefined, fullKey));
  }
  if (isRecord(submitted)) {
    const storedRec = isRecord(stored) ? stored : {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(submitted)) out[k] = unredact(v, storedRec[k], k, fullKey);
    return out;
  }
  return submitted;
}

/** Exclusive-create lock file with bounded retry; breaks locks older than `lockStaleMs`. */
async function acquireConfigLock(filePath: string, options: ApplyOpsOptions): Promise<() => void> {
  ensureDirs(options.env);
  mkdirSync(dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const timeoutMs = options.lockTimeoutMs ?? CONFIG_LOCK_TIMEOUT_MS;
  const staleMs = options.lockStaleMs ?? CONFIG_LOCK_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return () => { try { unlinkSync(lockPath); } catch { /* already gone */ } };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
        try { unlinkSync(lockPath); } catch { /* raced with another breaker */ }
        continue;
      }
    } catch { continue; /* lock vanished: retry immediately */ }
    if (Date.now() >= deadline) {
      throw new CrontickError(
        'CONFIG_LOCKED',
        `Config file ${filePath} is locked by another writer (${lockPath}). Retry shortly; if no other crontick process is writing, delete the lock file.`,
        { path: filePath, lock: lockPath },
      );
    }
    await sleep(CONFIG_LOCK_RETRY_MS);
  }
}

/** tmp + rename, preserving an existing file's mode (new files are 0600) and retrying EPERM/EBUSY. */
async function writeConfigAtomic(filePath: string, content: string, env?: NodeJS.ProcessEnv): Promise<void> {
  ensureDirs(env);
  mkdirSync(dirname(filePath), { recursive: true });
  let mode = 0o600;
  try { mode = statSync(filePath).mode & 0o777; } catch { /* new file */ }
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, content, { encoding: 'utf-8', mode });
    try { chmodSync(tmpPath, mode); } catch { /* no-op where unsupported */ }
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmpPath, filePath);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= CONFIG_RENAME_RETRIES) throw err;
        await sleep(CONFIG_RENAME_RETRY_MS * (attempt + 1));
      }
    }
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
