/**
 * Zod schemas for `config.json`. The config is strict — no extra fields allowed.
 * A refinement enforces that `defaultEngine` references a key in `engines` and
 * that at least one engine exists.
 */
import { z } from 'zod';
import {
  DEFAULT_MAX_LOG_FILES,
  DEFAULT_MAX_OUTPUT_BYTES_PER_RUN,
  DEFAULT_RUN_RETENTION_CAP,
} from '../constants/retention.js';

/** Shared regex for config key paths and engine names (letters, numbers, underscore, dash, dot). */
export const ConfigKeySchema = z.string().regex(
  /^[A-Za-z0-9_.-]+$/,
  'Config key paths can contain letters, numbers, underscore, dash, and dot',
);

export const EngineNameSchema = z.string().regex(
  /^[A-Za-z0-9_.-]+$/,
  'Engine names can contain letters, numbers, underscore, dash, and dot',
);

export const EngineConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  type: z.enum(['claude', 'raw']).default('raw'),
}).strict();

/**
 * `min(1)`: a job must retain at least its own most recent run to be useful.
 * `max(100_000)`: a sanity ceiling rejecting fat-finger values that would make
 * the per-insert eviction query (COUNT + ORDER BY ... LIMIT) pointlessly
 * expensive on a table that's supposed to stay small.
 *
 * `maxOutputBytesPerRun`: caps stdout+stderr bytes captured per run before
 * the daemon stops persisting further output for that run (see
 * docs/implementation/prompt-execution.md and src/daemon/runner.ts's captureChunk).
 * `min(1024)`: below this, even the truncation marker line barely fits.
 * `max(1_000_000_000)`: a sanity ceiling, same rationale as maxRunsPerJob.
 *
 * `maxLogFiles` (Minor 6): caps how many daily `daemon-YYYY-MM-DD.log` files
 * are kept under logsDir before the oldest are deleted (see
 * pruneOldDaemonLogs() in src/daemon/index.ts) — run history has always been
 * bounded by maxRunsPerJob; daemon logs previously had no cap or cleanup at
 * all and could accumulate indefinitely on a long-lived install.
 * `min(1)`: always keep at least today's log file. `max(3650)`: a sanity
 * ceiling (roughly 10 years of daily files), same rationale as the other
 * retention fields.
 */
export const RetentionConfigSchema = z.object({
  maxRunsPerJob: z.number().int().min(1).max(100_000).default(DEFAULT_RUN_RETENTION_CAP),
  maxOutputBytesPerRun: z.number().int().min(1024).max(1_000_000_000).default(DEFAULT_MAX_OUTPUT_BYTES_PER_RUN),
  maxLogFiles: z.number().int().min(1).max(3650).default(DEFAULT_MAX_LOG_FILES),
}).strict();

/**
 * Per-job log file settings (added alongside the `crontick` log stream). When
 * `fileEnabled` is true (the default), the daemon mirrors every run's engine
 * output AND crontick-side lifecycle events to `<dir>/<jobGuid>.log`, in
 * addition to the SQLite run-log storage. `dir` overrides the target
 * directory; when omitted it defaults to the `logs/` subfolder of the data
 * directory (see src/paths.ts logsDir). All file writes are best-effort and
 * never block or fail a run, so this is purely additive observability.
 */
export const LoggingConfigSchema = z.object({
  fileEnabled: z.boolean().default(true),
  dir: z.string().min(1).optional(),
}).strict();

/** Job values copied into new job definitions when the input omits them. */
export const JobDefaultsConfigSchema = z.object({
  overlap: z.enum(['skip', 'queue', 'cancel-previous']).default('skip'),
  timeoutSec: z.number().positive().optional(),
  retry: z.object({
    max: z.number().int().min(0).default(0),
    backoffSec: z.number().positive().default(30),
  }).strict().default({ max: 0, backoffSec: 30 }),
}).strict();

/**
 * Top-level config schema. File config is deep-merged over BUILT_IN_CONFIG
 * (defined in src/config.ts), then validated here. The refinement ensures
 * `defaultEngine` actually exists in `engines`.
 */
export const ConfigSchema = z.object({
  defaultEngine: EngineNameSchema.default('claude'),
  engines: z.record(EngineNameSchema, EngineConfigSchema).default({
    claude: { command: 'claude', args: [], env: {}, type: 'claude' },
  }),
  retention: RetentionConfigSchema.default({
    maxRunsPerJob: DEFAULT_RUN_RETENTION_CAP,
    maxOutputBytesPerRun: DEFAULT_MAX_OUTPUT_BYTES_PER_RUN,
    maxLogFiles: DEFAULT_MAX_LOG_FILES,
  }),
  logging: LoggingConfigSchema.default({ fileEnabled: true }),
  defaults: JobDefaultsConfigSchema.default({ overlap: 'skip', retry: { max: 0, backoffSec: 30 } }),
}).strict().superRefine((config, ctx) => {
  if (Object.keys(config.engines).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['engines'],
      message: 'engines must contain at least one engine',
    });
  }
  if (!Object.prototype.hasOwnProperty.call(config.engines, config.defaultEngine)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultEngine'],
      message: `defaultEngine "${config.defaultEngine}" must match a key in engines`,
    });
  }
});

export type EngineConfig = z.infer<typeof EngineConfigSchema>;
export type CrontickConfig = z.infer<typeof ConfigSchema>;
export type RetentionConfig = z.infer<typeof RetentionConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type JobDefaultsConfig = z.infer<typeof JobDefaultsConfigSchema>;

/**
 * "Persisted" counterparts of the schemas above — every field is `.optional()`
 * and none carry a `.default(...)`. These validate exactly what's written to
 * `config.json` on disk, as opposed to `ConfigSchema` et al. which validate
 * the *effective* config (raw file deep-merged over BUILT_IN_CONFIG).
 *
 * Without this split, every write path (`config set`/`config unset`/engine
 * CRUD) round-tripped through the effective, fully-defaulted config and
 * re-persisted it, so `.default(...)` values (defaultEngine, retention.*, the
 * built-in Claude engine's fields) were baked back into the file on every
 * write — making `config unset` a no-op for any key that has a built-in
 * fallback. Write paths must build on these Persisted* schemas (see
 * `readRawStoredConfig`/`persistRawConfig` in src/config.ts) so that removing
 * a key actually removes it from disk; only `loadConfig`/`getConfigValue`
 * (effective reads) should merge in defaults.
 */
export const PersistedEngineConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  type: z.enum(['claude', 'raw']).optional(),
}).strict();

export const PersistedRetentionConfigSchema = z.object({
  maxRunsPerJob: z.number().int().min(1).max(100_000).optional(),
  maxOutputBytesPerRun: z.number().int().min(1024).max(1_000_000_000).optional(),
  maxLogFiles: z.number().int().min(1).max(3650).optional(),
}).strict();

export const PersistedLoggingConfigSchema = z.object({
  fileEnabled: z.boolean().optional(),
  dir: z.string().min(1).optional(),
}).strict();

export const PersistedJobDefaultsConfigSchema = z.object({
  overlap: z.enum(['skip', 'queue', 'cancel-previous']).optional(),
  timeoutSec: z.number().positive().optional(),
  retry: z.object({
    max: z.number().int().min(0).optional(),
    backoffSec: z.number().positive().optional(),
  }).strict().optional(),
}).strict();

export const PersistedConfigSchema = z.object({
  defaultEngine: EngineNameSchema.optional(),
  engines: z.record(EngineNameSchema, PersistedEngineConfigSchema).optional(),
  retention: PersistedRetentionConfigSchema.optional(),
  logging: PersistedLoggingConfigSchema.optional(),
  defaults: PersistedJobDefaultsConfigSchema.optional(),
}).strict();

export type PersistedConfig = z.infer<typeof PersistedConfigSchema>;
