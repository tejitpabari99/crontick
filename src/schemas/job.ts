import { z } from 'zod';

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

export const ScheduleSchema = z.discriminatedUnion('kind', [
  CronScheduleSchema,
  IntervalScheduleSchema,
  OneShotScheduleSchema,
]);

// ── Action ────────────────────────────────────────────────────────────────────

export const ScriptActionSchema = z.object({
  kind: z.literal('script'),
  script: z.string().min(1),
  shell: z.enum(['auto', 'bash', 'pwsh', 'cmd']).default('auto'),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  envFile: z.string().optional(),
  timeoutSec: z.number().positive().optional(),
});

export const ExecActionSchema = z.object({
  kind: z.literal('exec'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  envFile: z.string().optional(),
  timeoutSec: z.number().positive().optional(),
  // shell is intentionally absent: exec always uses shell=false to prevent injection
});

export const ActionSchema = z.discriminatedUnion('kind', [ScriptActionSchema, ExecActionSchema]);

// ── Supporting types ──────────────────────────────────────────────────────────

export const RetrySchema = z.object({
  max: z.number().int().min(0).default(0),
  backoffSec: z.number().positive().default(30),
});

export const BudgetsSchema = z.object({
  maxRunsPerDay: z.number().int().positive().nullable().default(null),
  maxTokensPerRun: z.number().int().positive().nullable().default(null),
});

// ── Job ───────────────────────────────────────────────────────────────────────

const kebabCase = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const JobSchema = z.object({
  id: z.string().regex(kebabCase, 'Job ID must be kebab-case (e.g. "my-job")'),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  schedule: ScheduleSchema,
  action: ActionSchema,
  catchup: z.enum(['run-once', 'run-all', 'skip']).default('skip'),
  overlap: z.enum(['skip', 'queue', 'cancel-previous']).default('skip'),
  retry: RetrySchema.default({ max: 0, backoffSec: 30 }),
  budgets: BudgetsSchema.default({ maxRunsPerDay: null, maxTokensPerRun: null }),
});

export type Job = z.infer<typeof JobSchema>;
export type JobInput = z.input<typeof JobSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type Action = z.infer<typeof ActionSchema>;
