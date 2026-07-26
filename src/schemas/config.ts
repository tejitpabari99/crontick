/**
 * Zod schemas for `config.json`. The config is strict — no extra fields allowed.
 * A refinement enforces that `defaultEngine` references a key in `engines` and
 * that at least one engine exists.
 */
import { z } from 'zod';

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
}).strict();

/**
 * `min(1)`: a job must retain at least its own most recent run to be useful.
 * `max(100_000)`: a sanity ceiling rejecting fat-finger values that would make
 * the per-insert eviction query (COUNT + ORDER BY ... LIMIT) pointlessly
 * expensive on a table that's supposed to stay small.
 *
 * `maxOutputBytesPerRun`: caps stdout+stderr bytes captured per run before
 * the daemon stops persisting further output for that run (see
 * docs/internals/executors.md and src/daemon/runner.ts's captureChunk).
 * `min(1024)`: below this, even the truncation marker line barely fits.
 * `max(1_000_000_000)`: a sanity ceiling, same rationale as maxRunsPerJob.
 */
export const RetentionConfigSchema = z.object({
  maxRunsPerJob: z.number().int().min(1).max(100_000).default(100),
  maxOutputBytesPerRun: z.number().int().min(1024).max(1_000_000_000).default(2_000_000),
}).strict();

/**
 * Top-level config schema. File config is deep-merged over BUILT_IN_CONFIG
 * (defined in src/config.ts), then validated here. The refinement ensures
 * `defaultEngine` actually exists in `engines`.
 */
export const ConfigSchema = z.object({
  defaultEngine: EngineNameSchema.default('copilot'),
  engines: z.record(EngineNameSchema, EngineConfigSchema).default({
    copilot: { command: 'copilot', args: [], env: {} },
  }),
  retention: RetentionConfigSchema.default({ maxRunsPerJob: 100, maxOutputBytesPerRun: 2_000_000 }),
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

