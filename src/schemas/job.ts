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
  // shell is intentionally absent: exec always uses shell=false to prevent injection
}).strict();

export const PromptEngineSchema = z.enum(['copilot', 'agency']);

const WINDOWS_COMMAND_LINE_LIMIT = 32_767;
const SAFE_PROMPT_COMMAND_LINE_LIMIT = 30_000;
const RESERVED_PROMPT_ARGS = new Set([
  '-p',
  '--prompt',
  '--session-id',
  '-r',
  '--resume',
  '--continue',
  '--connect',
]);

const PromptActionBaseSchema = z.object({
  kind: z.literal('prompt'),
  prompt: z.string().min(1),
  engine: PromptEngineSchema.default('copilot'),
  args: z.array(z.string()).default([]),
  sessionId: z.string().min(1).optional(),
  reuseSession: z.boolean().default(false),
  ...CommonActionFields,
}).strict();

export const PromptActionSchema = PromptActionBaseSchema.superRefine((action, ctx) => {
  if (action.sessionId && action.reuseSession) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reuseSession'],
      message: 'sessionId and reuseSession are mutually exclusive',
    });
  }
  addPromptRuntimeIssues(action, ctx);
});

export const ActionSchema = z.discriminatedUnion('kind', [
  ScriptActionSchema,
  ExecActionSchema,
  PromptActionBaseSchema,
]).superRefine((action, ctx) => {
  if (action.kind === 'prompt' && action.sessionId && action.reuseSession) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reuseSession'],
      message: 'sessionId and reuseSession are mutually exclusive',
    });
  }
  if (action.kind === 'prompt') addPromptRuntimeIssues(action, ctx);
});

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
export type PromptAction = z.infer<typeof PromptActionBaseSchema>;
export type PromptEngine = z.infer<typeof PromptEngineSchema>;

function addPromptRuntimeIssues(action: z.infer<typeof PromptActionBaseSchema>, ctx: z.RefinementCtx): void {
  const reserved = action.args.find(isReservedPromptArg);
  if (reserved) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['args'],
      message: `Raw prompt engine args cannot include crontick-managed prompt/session flag: ${reserved}`,
    });
  }

  const argv =
    action.engine === 'agency'
      ? ['agency', 'cp', `--prompt=${action.prompt}`, ...action.args]
      : ['copilot', `--prompt=${action.prompt}`, ...action.args];
  if (action.sessionId) argv.push(`--session-id=${action.sessionId}`);
  const estimatedLength = estimateWindowsCommandLineLength(argv);
  if (estimatedLength > SAFE_PROMPT_COMMAND_LINE_LIMIT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['prompt'],
      message: `Prompt plus engine arguments exceed the Windows-safe command line limit (${estimatedLength}/${WINDOWS_COMMAND_LINE_LIMIT} characters). Shorten the prompt or arguments.`,
    });
  }
}

function isReservedPromptArg(arg: string): boolean {
  return RESERVED_PROMPT_ARGS.has(arg)
    || arg.startsWith('--prompt=')
    || arg.startsWith('--session-id=')
    || arg.startsWith('--resume=')
    || arg.startsWith('--connect=');
}

function estimateWindowsCommandLineLength(argv: string[]): number {
  return argv.reduce((total, arg, index) => total + (index === 0 ? 0 : 1) + quoteForWindowsEstimate(arg).length, 0);
}

function quoteForWindowsEstimate(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/(\\*)"/g, '$1$1\\"')}"` : arg;
}
