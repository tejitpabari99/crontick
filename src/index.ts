/**
 * Public API boundary. Everything exported here is public, covered by semver,
 * and may be imported as `import { ... } from 'crontick'`. Anything not
 * re-exported from this file is internal and may change without notice.
 *
 * Some CrontickClient methods (getConfig, health, ensure, drainNotices,
 * isVerbose, jobJsonSchema, createJobFromCliOptions) are intentionally
 * library-only — they serve internal wiring or direct-use scenarios and are
 * outside the surface-parity contract enforced by tests/surface-drift.test.ts.
 */

export { VERSION } from './version.js';
export { CrontickError } from './errors.js';
export { CrontickClient, createClient } from './client.js';
export type {
  CrontickClientOptions,
  JobStats,
  LogEntry,
  LogsResult,
  StatsSummary,
} from './client.js';
export {
  buildJobFromCreateOptions,
  buildJobPatchFromUpdateOptions,
  applyConfigDefaults,
  normalizeJobInput,
  normalizeJobPatch,
} from './job-input.js';
export type {
  ActionInput,
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
export { ConfigSchema, EngineConfigSchema } from './schemas/config.js';
export type { CrontickConfig, EngineConfig } from './schemas/config.js';
export {
  JobSchema,
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
  DashboardStartResult,
  DashboardStats,
  DashboardStatus,
  DashboardStopResult,
} from './dashboard.js';
export { SURFACE_CAPABILITIES } from './surface.js';
export type { SurfaceCapability } from './surface.js';
export { createLogger, isVerboseEnv, nullLogger, redactText, redactValue, sanitizeLogEvent } from './logger.js';
export type { LogEvent, Logger, LoggerOptions, LogLevel, LogSink } from './logger.js';
