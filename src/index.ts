/**
 * Public API boundary. Everything exported here is public, covered by semver,
 * and may be imported as `import { ... } from 'crontick'`. Anything not
 * re-exported from this file is internal and may change without notice.
 *
 * Some CrontickClient methods (getConfig, health, ensure, drainNotices,
 * isVerbose, jobJsonSchema, createJobFromCliOptions, configPath, daemonStart,
 * daemonStatus, daemonRestart) are intentionally library-only — they serve
 * internal wiring or direct-use scenarios and are outside the surface-parity
 * contract enforced by tests/unit/surface-drift.test.ts.
 */

export { VERSION } from './version.js';
export { CrontickError, ORPHAN_RUN_ERROR_CODE, ORPHAN_RUN_ERROR_MESSAGE } from './errors.js';
export { CrontickClient, createClient, LOG_SOURCES } from './client.js';
export type { NormalizedUsage } from './run-output.js';
export type {
  ConfigPathInfo,
  CreateJobOptions,
  CrontickClientOptions,
  CrontickInfo,
  CrontickInfoPaths,
  DaemonStatus,
  JobStats,
  LogEntry,
  LogSource,
  LogsResult,
  RunOutput,
  RunRecord,
  StatsSummary,
} from './client.js';
export {
  buildJobFromCreateOptions,
  buildJobPatchFromUpdateOptions,
  applyConfigDefaults,
  generateAlias,
  normalizeJobInput,
  normalizeJobPatch,
  DEFAULT_ALIAS_WORDS,
} from './job-input.js';
export type {
  ActionInput,
  GenerateAliasOptions,
  JobCreateCliOptions,
  JobCreateInput,
  JobPatchCliOptions,
  JobPatchInput,
  NormalizeJobInputOptions,
  PromptActionInput,
} from './job-input.js';
export { jobJsonSchema, jobJsonSchemaText } from './schema-json.js';
export {
  BUILT_IN_CONFIG,
  addEngine,
  buildPromptRunCommand,
  configFilePath,
  getConfigValue,
  initConfig,
  listEngines,
  loadConfig,
  readConfigFile,
  removeConfigValue,
  removeEngine,
  setConfigValue,
  updateEngine,
  validateConfigFile,
  writeConfigFile,
} from './config.js';
export { ConfigSchema, EngineConfigSchema, RetentionConfigSchema } from './schemas/config.js';
export type { CrontickConfig, EngineConfig, RetentionConfig } from './schemas/config.js';
export {
  JobSchema,
  JOB_ALIAS_PATTERN,
  PromptActionSchema,
  PromptEngineSchema,
  ScheduleSchema,
} from './schemas/job.js';
export type { Job, JobInput, Schedule, Action, PromptAction, PromptEngine } from './schemas/job.js';
export type {
  DashboardData,
  DashboardHealth,
  DashboardJob,
  DashboardOptions,
  DashboardRun,
  DashboardStats,
  DashboardStatus,
} from './dashboard.js';
export { SURFACE_CAPABILITIES } from './surface.js';
export type { SurfaceCapability } from './surface.js';
export { createLogger, isVerboseEnv, nullLogger, redactText, redactValue, sanitizeLogEvent } from './logger.js';
export type { LogEvent, Logger, LoggerOptions, LogLevel, LogSink } from './logger.js';
