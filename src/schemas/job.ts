/**
 * Zod schemas for job definitions — the validation rules users hit on every
 * create/update. The schemas form discriminated unions keyed on `kind` for both
 * schedules and actions. All action schemas use `.strict()` to reject unknown fields.
 */
import { z } from 'zod';
import { promptRuntimeValidationMessage } from '../prompt-runtime.js';
import { EngineNameSchema } from './config.js';

// ── Schedule ──────────────────────────────────────────────────────────────────

export const CronScheduleSchema = z.object({
  kind: z.literal('cron'),
  cron: z.string().min(1),
  tz: z.string().optional(),
});

export const IntervalScheduleSchema = z.object({
  kind: z.literal('interval'),
  everySec: z.number().positive(),
  startAt: z.string().optional(), // ISO-8601
});

export const OneShotScheduleSchema = z.object({
  kind: z.literal('one-shot'),
  runAt: z.string().min(1), // ISO-8601
});

/** Schedule discriminated union; croner v9 validates the cron expression at runtime. */
export const ScheduleSchema = z.discriminatedUnion('kind', [
  CronScheduleSchema,
  IntervalScheduleSchema,
  OneShotScheduleSchema,
]);

// ── Action ────────────────────────────────────────────────────────────────────

const CommonActionFields = {
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  envFile: z.string().optional(),
  timeoutSec: z.number().positive().optional(),
};

export const ScriptActionSchema = z.object({
  kind: z.literal('script'),
  script: z.string().min(1),
  shell: z.enum(['auto', 'bash', 'pwsh', 'cmd']).default('auto'),
  ...CommonActionFields,
}).strict();

export const ExecActionSchema = z.object({
  kind: z.literal('exec'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  ...CommonActionFields,
}).strict();

export const PromptEngineSchema = EngineNameSchema;

/**
 * Prompt action before runtime refinement; used as the base for the
 * discriminated union (superRefine is applied on ActionSchema, not here)
 * so that union discrimination on `kind` works correctly.
 */
export const PromptActionBaseSchema = z.object({
  kind: z.literal('prompt'),
  prompt: z.string().min(1),
  engine: PromptEngineSchema.optional(),
  args: z.array(z.string()).default([]),
  sessionId: z.string().min(1).optional(),
  reuseSession: z.boolean().default(false),
  ...CommonActionFields,
}).strict();

/** Standalone prompt action schema with runtime validation (Windows cmd-line length, reserved args). */
export const PromptActionSchema = PromptActionBaseSchema.superRefine(addPromptRuntimeIssues);

/**
 * Action discriminated union keyed on `kind`. Uses PromptActionBaseSchema
 * (not PromptActionSchema) as the union member because Zod discriminatedUnion
 * requires plain objects; the prompt refinement is re-applied via superRefine.
 */
export const ActionSchema = z.discriminatedUnion('kind', [
  ScriptActionSchema,
  ExecActionSchema,
  PromptActionBaseSchema,
]).superRefine((action, ctx) => {
  if (action.kind === 'prompt') addPromptRuntimeIssues(action, ctx);
});

// ── Supporting types ──────────────────────────────────────────────────────────

export const RetrySchema = z.object({
  max: z.number().int().min(0).default(0),
  backoffSec: z.number().positive().default(30),
});

// ── Job ───────────────────────────────────────────────────────────────────────

/** Permanent: job IDs are kebab-case, used as filenames and primary keys. Cannot be renamed. */
const kebabCase = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const JobSchema = z.object({
  id: z.string().regex(kebabCase, 'Job ID must be kebab-case (e.g. "my-job")'),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  schedule: ScheduleSchema,
  action: ActionSchema,
  /** Default 'skip' means new ticks are discarded when a run is already active. */
  overlap: z.enum(['skip', 'queue', 'cancel-previous']).default('skip'),
  retry: RetrySchema.default({ max: 0, backoffSec: 30 }),
});

export type Job = z.infer<typeof JobSchema>;
export type JobInput = z.input<typeof JobSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type PromptAction = z.infer<typeof PromptActionBaseSchema>;
export type PromptEngine = z.infer<typeof PromptEngineSchema>;

/** Applies Windows cmd-line length check and reserved-arg detection to prompt actions. */
function addPromptRuntimeIssues(action: z.infer<typeof PromptActionBaseSchema>, ctx: z.RefinementCtx): void {
  const message = promptRuntimeValidationMessage(action);
  if (message) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: message.includes('Windows-safe') ? ['prompt'] : ['args'],
      message,
    });
  }
}
