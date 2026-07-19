// Script to generate job.schema.json from the Zod schema
// Run: node scripts/generate-schema.mjs
import { z } from '../node_modules/zod/index.js';
import { zodToJsonSchema } from '../node_modules/zod-to-json-schema/dist/esm/index.js';
import { writeFileSync } from 'node:fs';

const kebabCase = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CronScheduleSchema = z.object({
  kind: z.literal('cron'),
  cron: z.string().min(1),
  tz: z.string().optional(),
});

const IntervalScheduleSchema = z.object({
  kind: z.literal('interval'),
  everySec: z.number().positive(),
  startAt: z.string().optional(),
});

const OneShotScheduleSchema = z.object({
  kind: z.literal('one-shot'),
  runAt: z.string().min(1),
});

const ScheduleSchema = z.discriminatedUnion('kind', [
  CronScheduleSchema,
  IntervalScheduleSchema,
  OneShotScheduleSchema,
]);

const ScriptActionSchema = z.object({
  kind: z.literal('script'),
  script: z.string().min(1),
  shell: z.enum(['auto', 'bash', 'pwsh', 'cmd']).default('auto'),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  timeoutSec: z.number().positive().optional(),
});

const ExecActionSchema = z.object({
  kind: z.literal('exec'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  timeoutSec: z.number().positive().optional(),
});

const ActionSchema = z.discriminatedUnion('kind', [ScriptActionSchema, ExecActionSchema]);

const RetrySchema = z.object({
  max: z.number().int().min(0).default(0),
  backoffSec: z.number().positive().default(30),
});

const BudgetsSchema = z.object({
  maxRunsPerDay: z.number().int().positive().nullable().default(null),
  maxTokensPerRun: z.number().int().positive().nullable().default(null),
});

const JobSchema = z.object({
  id: z.string().regex(kebabCase, 'Job ID must be kebab-case'),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  schedule: ScheduleSchema,
  action: ActionSchema,
  catchup: z.enum(['run-once', 'run-all', 'skip']).default('skip'),
  overlap: z.enum(['skip', 'queue', 'cancel-previous']).default('skip'),
  retry: RetrySchema.default({ max: 0, backoffSec: 30 }),
  budgets: BudgetsSchema.default({ maxRunsPerDay: null, maxTokensPerRun: null }),
});

const schema = zodToJsonSchema(JobSchema, {
  name: 'CrontickJob',
  $refStrategy: 'none',
  errorMessages: true,
});

writeFileSync('./src/schemas/job.schema.json', JSON.stringify(schema, null, 2));
// eslint-disable-next-line no-undef -- Node.js script running in CJS context
console.log('Generated src/schemas/job.schema.json');
