/**
 * Zod schemas for job definitions — the validation rules users hit on every
 * create/update. The schemas form discriminated unions keyed on `kind` for both
 * schedules and actions. All action schemas use `.strict()` to reject unknown fields.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { promptRuntimeValidationMessage } from '../prompt-runtime.js';
import { EngineNameSchema } from './config.js';
import { isReservedJobRef } from '../utils/job-ref.js';
import { isValidRelayUrl } from '../utils/relay-url.js';

// ── Schedule ──────────────────────────────────────────────────────────────────

export const CronScheduleSchema = z.object({
  kind: z.literal('cron'),
  cron: z.string().min(1).describe('Cron expression, e.g. "0 9 * * *" (fires in the machine local timezone)'),
});

export const IntervalScheduleSchema = z.object({
  kind: z.literal('interval'),
  everySec: z.number().positive().describe('Repeat interval in seconds (the CLI --every flag also accepts s/m/h/d suffixes, e.g. 30m)'),
  startAt: z.string().optional().describe('ISO-8601 time the interval starts counting from'),
});

export const OneShotScheduleSchema = z.object({
  kind: z.literal('one-shot'),
  runAt: z.string().min(1).describe('One-shot run time, ISO-8601 (e.g. 2026-10-01T09:00). Interpreted in the machine local timezone unless an offset such as Z or +02:00 is given'),
});

/**
 * Non-time trigger: fires when the upstream job's run reaches a terminal status.
 * `jobId` is the upstream GUID (never an alias: aliases are user-editable).
 * `failure` matches failed or timeout runs.
 */
export const AfterScheduleSchema = z.object({
  kind: z.literal('after'),
  jobId: z.string().uuid().describe('Upstream job GUID (never an alias)'),
  status: z.enum(['success', 'failure', 'any']).describe('Which upstream terminal outcome triggers this job'),
});

/**
 * Non-time trigger: fires on events from an outbound-SSE relay (smee.io-style) or a local trigger.
 * `relay` is a bearer secret URL (https, or http for loopback hosts only); omitted = local-trigger-only.
 */
export const WebhookScheduleSchema = z.object({
  kind: z.literal('webhook'),
  relay: z.string().refine(isValidRelayUrl, { message: 'relay must be an https URL (http is allowed only for loopback hosts)' }).optional()
    .describe('Relay channel URL (smee.io-style SSE); treat as a secret. Omit for a local-trigger-only job'),
  secret: z.string().min(1).optional().describe('Optional HMAC secret verifying x-hub-signature-256 on relay events'),
});

/** Schedule discriminated union (exactly one schedule per job); croner v9 validates the cron expression at runtime. */
export const ScheduleSchema = z.discriminatedUnion('kind', [
  CronScheduleSchema,
  IntervalScheduleSchema,
  OneShotScheduleSchema,
  AfterScheduleSchema,
  WebhookScheduleSchema,
]);

export type TimeSchedule = Exclude<z.infer<typeof ScheduleSchema>, z.infer<typeof AfterScheduleSchema> | z.infer<typeof WebhookScheduleSchema>>;

/** True for schedule kinds driven by the clock (cron, interval, one-shot); false for event-driven kinds. */
export function isTimeSchedule(schedule: z.infer<typeof ScheduleSchema>): schedule is TimeSchedule {
  switch (schedule.kind) {
    case 'cron':
    case 'interval':
    case 'one-shot':
      return true;
    case 'after':
    case 'webhook':
      return false;
  }
}

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
 * Action discriminated union keyed on `kind`. Prompt is the only member
 * (crontick is prompt-only -- see docs/decisions/0002-prompt-only-jobs-and-engine-adapters.md).
 * `kind: 'prompt'` is kept explicit so job JSON stays self-describing and a
 * future action kind can be added. Uses PromptActionBaseSchema (not
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

/** Alias validation shared by create, update and import: kebab-case and not a reserved ref (e.g. `all`). */
export const JobAliasSchema = z
  .string()
  .regex(JOB_ALIAS_PATTERN, 'Job alias must be kebab-case (e.g. "my-job")')
  .refine((a) => !isReservedJobRef(a), { message: 'Job alias "all" is reserved' });

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
  alias: JobAliasSchema.optional().describe('Unique kebab-case job alias (set via CLI --alias); auto-generated when omitted'),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  schedule: ScheduleSchema,
  action: ActionSchema,
  /** Default 'skip' means new ticks are discarded when a run is already active. */
  overlap: z.enum(['skip', 'queue', 'cancel-previous']).default('skip'),
  retry: RetrySchema.default({ max: 0, backoffSec: 30 }),
  /** Run the most recent missed fire after downtime. Only meaningful for time schedules (cron, interval, one-shot). */
  catchUp: z.boolean().default(false).describe('Run the most recent missed fire once after downtime (cron, interval, one-shot schedules only)'),
});

/** A reused session (captured via reuseSession, or fixed via explicit sessionId) may have only one in-flight turn. */
export const JobSchema = JobBaseSchema.superRefine((job, ctx) => {
  const reusesSession = job.action.kind === 'prompt' && (job.action.reuseSession || job.action.sessionId !== undefined);
  if (reusesSession && job.overlap !== 'skip') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['overlap'],
      message: 'reuseSession or an explicit sessionId requires overlap: skip',
    });
  }
  if (job.catchUp && !isTimeSchedule(job.schedule)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['catchUp'],
      message: `catchUp is only valid for cron, interval and one-shot schedules, not ${job.schedule.kind}`,
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
