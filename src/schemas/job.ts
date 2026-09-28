/**
 * Zod schemas for job definitions — the validation rules users hit on every
 * create/update. The schemas form discriminated unions keyed on `kind` for both
 * schedules and actions. All action schemas use `.strict()` to reject unknown fields.
 */
import { randomUUID } from 'node:crypto';
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
 * Action discriminated union keyed on `kind`. Prompt is the only member since
 * the `script`/`exec` action kinds were removed (crontick is prompt-only --
 * see docs/decisions/0028-prompt-only-jobs.md). `kind: 'prompt'` is kept
 * explicit (rather than dropping the discriminant and flattening the action
 * shape) so job JSON stays self-describing and forward-compatible with a
 * future action kind, and so existing job files/tooling that read
 * `action.kind` keep working unchanged. Uses PromptActionBaseSchema (not
 * PromptActionSchema) as the union member because Zod discriminatedUnion
 * requires plain objects; the prompt refinement is re-applied via superRefine.
 */
export const ActionSchema = z.discriminatedUnion('kind', [
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

/**
 * Kebab-case pattern the human-friendly `alias` field must match (e.g.
 * "my-job"). Exported so callers can validate an alias against the same rule.
 */
export const JOB_ALIAS_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Immutable primary key: a GUID assigned once at creation and never changed
 * (see docs/decisions and docs/concepts/jobs.md). Runs, the scheduler, and
 * every internal reference key off this value. When omitted from input, a
 * fresh id is generated -- collision-free for practical purposes without
 * needing to consult existing jobs (unlike `alias`, which does).
 */
export const JobBaseSchema = z.object({
  id: z.string().uuid().default(() => randomUUID()),
  /**
   * Human-friendly, user-editable, OPTIONAL identifier. Enforced unique only
   * among currently-defined (live) jobs -- deleting a job frees its alias for
   * reuse. Resolution (see CrontickClient/daemon API) accepts either the
   * GUID `id` or the `alias` wherever a job identifier is expected; `id` is
   * tried first, falling back to `alias`. When omitted on create, one is
   * auto-generated (see generateAlias in job-input.ts).
   */
  alias: z.string().regex(JOB_ALIAS_PATTERN, 'Job alias must be kebab-case (e.g. "my-job")').optional(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  schedule: ScheduleSchema,
  action: ActionSchema,
  /** Default 'skip' means new ticks are discarded when a run is already active. */
  overlap: z.enum(['skip', 'queue', 'cancel-previous']).default('skip'),
  retry: RetrySchema.default({ max: 0, backoffSec: 30 }),
});

/** A reused session may have only one in-flight turn. */
export const JobSchema = JobBaseSchema.superRefine((job, ctx) => {
  if (job.action.reuseSession && job.overlap !== 'skip') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['overlap'],
      message: 'reuseSession requires overlap: skip',
    });
  }
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
