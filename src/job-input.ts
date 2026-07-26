/**
 * Job input normalization and CLI-to-job construction. This module converts
 * user-friendly input shapes (promptFile, CLI flags, partial patches) into the
 * canonical persisted Job shape. Key transformations:
 * - `promptFile` is read from disk and becomes `prompt` (never persisted as path)
 * - Engine defaults are resolved from config when not specified
 * - `reuseSession` is cleared when an explicit `sessionId` is already set
 * - Prompt runtime validation (Windows cmd-line length, reserved args) is applied
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { CrontickError } from './errors.js';
import {
  ExecActionSchema,
  JobSchema,
  PromptActionBaseSchema,
  RetrySchema,
  ScheduleSchema,
  ScriptActionSchema,
  type Job,
  type JobInput,
} from './schemas/job.js';
import { EngineNameSchema } from './schemas/config.js';
import { loadConfig } from './config.js';
import { promptRuntimeValidationMessage } from './prompt-runtime.js';

/**
 * Input schema extends prompt action to accept `promptFile` as an alternative
 * to `prompt`. During normalization, the file is read and inlined.
 */
export const PromptActionInputSchema = PromptActionBaseSchema.omit({ prompt: true }).extend({
  prompt: z.string().min(1).optional(),
  promptFile: z.string().min(1).optional(),
}).strict();

export const ActionInputSchema = z.discriminatedUnion('kind', [
  ScriptActionSchema,
  ExecActionSchema,
  PromptActionInputSchema,
]);

export const JobCreateInputSchema = JobSchema.omit({ action: true }).extend({
  action: ActionInputSchema,
});

export const JobPatchInputSchema = z.object({
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  schedule: ScheduleSchema.optional(),
  action: ActionInputSchema.optional(),
  overlap: z.enum(['skip', 'queue', 'cancel-previous']).optional(),
  retry: RetrySchema.optional(),
}).strict();

export type PromptActionInput = z.input<typeof PromptActionInputSchema>;
export type ActionInput = z.input<typeof ActionInputSchema>;
export type JobCreateInput = Omit<JobInput, 'action'> & { action: ActionInput };
export type JobPatchInput = z.input<typeof JobPatchInputSchema>;

export interface NormalizeJobInputOptions {
  cwd?: string;
  fileBaseDir?: string;
  maxPromptFileBytes?: number;
  env?: NodeJS.ProcessEnv;
  onNotice?: (message: string) => void;
}

export interface JobCreateCliOptions {
  id: string;
  engineArgs?: string[];
  rawArgs?: string[];
  file?: string;
  cron?: string;
  every?: number;
  at?: string;
  tz?: string;
  script?: string;
  exec?: string;
  prompt?: string;
  promptFile?: string;
  engine?: string;
  sessionId?: string;
  reuseSession?: boolean;
  shell?: string;
  envFile?: string;
  timeout?: number;
  overlap?: string;
  retry?: number;
  desc?: string;
  enabled?: boolean;
}

export type JobPatchCliOptions = Omit<JobCreateCliOptions, 'id'>;

const DEFAULT_MAX_PROMPT_FILE_BYTES = 1024 * 1024;

/** Validates and normalizes a full job create input into the canonical persisted shape. */
export function normalizeJobInput(
  input: JobCreateInput,
  options: NormalizeJobInputOptions = {},
): Job {
  const normalized = {
    ...input,
    action: normalizeActionInput(input.action, options),
  };

  const parsed = JobSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new CrontickError('VALIDATION_ERROR', 'Invalid job', parsed.error.format());
  }
  return parsed.data;
}

/** Fills in the default engine for prompt jobs that omit it (derived field, not user-supplied). */
export function applyConfigDefaults(job: Job, options: NormalizeJobInputOptions = {}): Job {
  if (job.action.kind !== 'prompt' || job.action.engine !== undefined) return job;
  return {
    ...job,
    action: {
      ...job.action,
      engine: loadConfig({ env: options.env }).defaultEngine,
    },
  };
}

/** Merges patch over existing job, re-validates the full result, and returns canonical shape. */
export function normalizeJobPatch(
  id: string,
  existing: Job,
  patch: JobPatchInput,
  options: NormalizeJobInputOptions = {},
): Job {
  const normalizedPatch = patch.action
    ? { ...patch, action: normalizeActionInput(patch.action, options) }
    : patch;
  const parsed = JobSchema.safeParse({ ...existing, ...normalizedPatch, id });
  if (!parsed.success) {
    throw new CrontickError('VALIDATION_ERROR', 'Invalid job', parsed.error.format());
  }
  return parsed.data;
}

/** Constructs a full Job from CLI flags; supports --file (JSON) as an alternative to flags. */
export function buildJobFromCreateOptions(
  input: JobCreateCliOptions,
  options: NormalizeJobInputOptions = {},
): Job {
  if (input.file) {
    assertFileModeExclusive(input, input.rawArgs ?? input.engineArgs ?? []);
    const filePath = resolve(options.cwd ?? process.cwd(), input.file);
    const raw = readFileSync(filePath, 'utf-8');
    return normalizeJobInput(JSON.parse(raw) as JobCreateInput, {
      ...options,
      fileBaseDir: dirname(filePath),
    });
  }

  const rawArgs = input.rawArgs ?? input.engineArgs ?? [];
  const jobData = {
    id: input.id,
    description: input.desc,
    enabled: input.enabled,
    schedule: buildSchedule(input),
    action: buildAction(input, rawArgs),
    overlap: (input.overlap ?? 'skip') as JobCreateInput['overlap'],
    retry: input.retry !== undefined ? { max: input.retry, backoffSec: 30 } : undefined,
  } satisfies JobCreateInput;
  return normalizeJobInput(jobData, options);
}

export function buildJobPatchFromUpdateOptions(
  input: JobPatchCliOptions,
  options: NormalizeJobInputOptions = {},
): JobPatchInput {
  if (input.file) {
    assertFileModeExclusive(input, input.rawArgs ?? input.engineArgs ?? []);
    const filePath = resolve(options.cwd ?? process.cwd(), input.file);
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JobPatchInputSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new CrontickError('VALIDATION_ERROR', 'Invalid job patch', parsed.error.format());
    return parsed.data.action
      ? { ...parsed.data, action: normalizeActionInput(parsed.data.action, { ...options, fileBaseDir: dirname(filePath) }) as ActionInput }
      : parsed.data;
  }

  const rawArgs = input.rawArgs ?? input.engineArgs ?? [];
  const patch: JobPatchInput = {};
  if (input.desc !== undefined) patch.description = input.desc;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  const schedule = maybeBuildSchedule(input);
  if (schedule !== undefined) patch.schedule = schedule;
  const action = maybeBuildAction(input, rawArgs);
  if (action !== undefined) patch.action = normalizeActionInput(action, options) as ActionInput;
  if (input.overlap !== undefined) patch.overlap = input.overlap as JobPatchInput['overlap'];
  if (input.retry !== undefined) patch.retry = { max: input.retry, backoffSec: 30 };

  const parsed = JobPatchInputSchema.safeParse(patch);
  if (!parsed.success) throw new CrontickError('VALIDATION_ERROR', 'Invalid job patch', parsed.error.format());
  return parsed.data;
}

/**
 * Normalizes a prompt action input: resolves promptFile, fills engine default,
 * clears redundant reuseSession, and runs runtime validation.
 */
function normalizeActionInput(action: ActionInput, options: NormalizeJobInputOptions): unknown {
  if (!isRecord(action) || action.kind !== 'prompt') return action;

  const prompt = typeof action.prompt === 'string' ? action.prompt : undefined;
  const promptFile = typeof action.promptFile === 'string' ? action.promptFile : undefined;
  if ((prompt ? 1 : 0) + (promptFile ? 1 : 0) !== 1) {
    throw new CrontickError(
      'VALIDATION_ERROR',
      'Prompt jobs require exactly one of prompt or promptFile',
    );
  }

  const { promptFile: _promptFile, ...rest } = action;
  void _promptFile;
  let normalized = {
    ...rest,
    prompt: prompt ?? readPromptFile(promptFile!, options),
  };
  if (normalized.engine === undefined) {
    normalized = {
      ...normalized,
      engine: loadConfig({ env: options.env }).defaultEngine,
    };
  }
  if (typeof normalized.sessionId === 'string' && normalized.reuseSession === true) {
    options.onNotice?.(
      'reuseSession was ignored because an explicit sessionId was provided; crontick will reuse the explicit session id.',
    );
    normalized = {
      ...normalized,
      reuseSession: false,
    };
  }
  validatePromptActionRuntimeArgs(normalized);
  return normalized;
}

function validatePromptActionRuntimeArgs(action: Record<string, unknown>): void {
  const args = Array.isArray(action.args) ? action.args.filter(isString) : [];
  const message = promptRuntimeValidationMessage({
    prompt: typeof action.prompt === 'string' ? action.prompt : '',
    engine: typeof action.engine === 'string' ? action.engine : 'copilot',
    args,
    sessionId: typeof action.sessionId === 'string' ? action.sessionId : undefined,
  });
  if (message) throw new CrontickError('VALIDATION_ERROR', message);
}

function buildSchedule(input: JobCreateCliOptions): JobCreateInput['schedule'] {
  const schedule = maybeBuildSchedule(input);
  if (!schedule) throw new CrontickError('MISSING_ARG', 'Provide --cron, --every <sec>, or --at <iso>');
  return schedule;
}

function maybeBuildSchedule(input: JobPatchCliOptions): JobCreateInput['schedule'] | undefined {
  const count = [input.cron, input.every, input.at].filter((value) => value !== undefined).length;
  if (count === 0) return undefined;
  if (count > 1) throw new CrontickError('VALIDATION_ERROR', 'Provide only one schedule source: --cron, --every, or --at');
  if (input.cron !== undefined) return { kind: 'cron', cron: input.cron, tz: input.tz };
  if (input.every !== undefined) return { kind: 'interval', everySec: input.every };
  if (input.at !== undefined) return { kind: 'one-shot', runAt: input.at };
  return undefined;
}

function buildAction(input: JobCreateCliOptions, rawArgs: string[]): ActionInput {
  const action = maybeBuildAction(input, rawArgs);
  if (!action) throw new CrontickError('MISSING_ARG', 'Provide --script, --exec, --prompt, or --prompt-file');
  return action;
}

function maybeBuildAction(input: JobPatchCliOptions, rawArgs: string[]): ActionInput | undefined {
  const actionSourceCount = [input.script, input.exec, input.prompt, input.promptFile].filter(
    (value) => value !== undefined,
  ).length;
  if (actionSourceCount === 0) {
    if (rawArgs.length > 0 || input.engine !== undefined || input.sessionId !== undefined || input.reuseSession) {
      throw new CrontickError(
        'VALIDATION_ERROR',
        'Prompt engine/session flags are valid only with prompt mode. Use --prompt or --prompt-file, or remove --engine/--session-id/--reuse-session.',
      );
    }
    return undefined;
  }
  if (actionSourceCount !== 1) {
    throw new CrontickError(
      'MISSING_ARG',
      'Provide exactly one action source: --script, --exec, --prompt, or --prompt-file',
    );
  }

  const promptMode = input.prompt !== undefined || input.promptFile !== undefined;
  if (!promptMode && rawArgs.length > 0) {
    throw new CrontickError(
      'VALIDATION_ERROR',
      'Raw engine args after -- are valid only with prompt mode. Use --prompt or --prompt-file, or remove the raw engine args.',
    );
  }
  if (!promptMode && (input.engine !== undefined || input.sessionId !== undefined || input.reuseSession)) {
    throw new CrontickError(
      'VALIDATION_ERROR',
      'Prompt engine/session flags are valid only with prompt mode. Use --prompt or --prompt-file, or remove --engine/--session-id/--reuse-session.',
    );
  }

  if (input.script !== undefined) {
    return {
      kind: 'script',
      script: input.script,
      shell: actionShell(input.shell),
      envFile: input.envFile,
      timeoutSec: input.timeout,
    };
  }
  if (input.exec !== undefined) {
    const parts = input.exec.split(/\s+/).filter(Boolean);
    return {
      kind: 'exec',
      command: parts[0] ?? '',
      args: parts.slice(1),
      envFile: input.envFile,
      timeoutSec: input.timeout,
    };
  }
  return {
    kind: 'prompt',
    prompt: input.prompt,
    promptFile: input.promptFile,
    engine: promptEngine(input.engine),
    args: rawArgs,
    sessionId: input.sessionId,
    reuseSession: input.reuseSession,
    envFile: input.envFile,
    timeoutSec: input.timeout,
  };
}

/** --file is mutually exclusive with all other schedule/action/prompt flags. */
function assertFileModeExclusive(opts: JobPatchCliOptions, rawArgs: string[]): void {
  const conflicting = rawArgs.length > 0
    || opts.cron !== undefined
    || opts.every !== undefined
    || opts.at !== undefined
    || opts.tz !== undefined
    || opts.script !== undefined
    || opts.exec !== undefined
    || opts.prompt !== undefined
    || opts.promptFile !== undefined
    || opts.engine !== undefined
    || opts.sessionId !== undefined
    || opts.reuseSession !== undefined
    || opts.shell !== undefined && opts.shell !== 'auto'
    || opts.envFile !== undefined
    || opts.timeout !== undefined
    || opts.overlap !== undefined && opts.overlap !== 'skip'
    || opts.retry !== undefined
    || opts.desc !== undefined
    || opts.enabled !== undefined;

  if (conflicting) {
    throw new CrontickError(
      'VALIDATION_ERROR',
      '--file is mutually exclusive with schedule, action, prompt, session, and raw engine arguments',
    );
  }
}

function actionShell(shell: string | undefined): 'auto' | 'bash' | 'pwsh' | 'cmd' {
  if (shell === 'bash' || shell === 'pwsh' || shell === 'cmd' || shell === 'auto' || shell === undefined) {
    return shell ?? 'auto';
  }
  throw new CrontickError('VALIDATION_ERROR', 'Shell must be auto, bash, pwsh, or cmd');
}

function promptEngine(engine: string | undefined): string | undefined {
  if (engine === undefined) return undefined;
  const parsed = EngineNameSchema.safeParse(engine);
  if (parsed.success) return parsed.data;
  throw new CrontickError('VALIDATION_ERROR', 'Prompt engine must be a valid engine name from crontick config');
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function readPromptFile(promptFile: string, options: NormalizeJobInputOptions): string {
  if (extname(promptFile).toLowerCase() !== '.txt') {
    throw new CrontickError('VALIDATION_ERROR', 'promptFile must point to a .txt file');
  }

  const baseDir = options.fileBaseDir ?? options.cwd ?? process.cwd();
  const filePath = isAbsolute(promptFile) ? promptFile : resolve(baseDir, promptFile);
  let stat;
  try {
    stat = statSync(filePath);
  } catch (err) {
    throw new CrontickError('VALIDATION_ERROR', `Failed to read promptFile: ${String(err)}`);
  }

  if (!stat.isFile()) {
    throw new CrontickError('VALIDATION_ERROR', 'promptFile must be a regular .txt file');
  }

  const maxBytes = options.maxPromptFileBytes ?? DEFAULT_MAX_PROMPT_FILE_BYTES;
  if (stat.size > maxBytes) {
    throw new CrontickError(
      'VALIDATION_ERROR',
      `promptFile exceeds maxPromptFileBytes (${maxBytes})`,
    );
  }

  const bytes = readFileSync(filePath);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CrontickError('VALIDATION_ERROR', 'promptFile must be valid UTF-8 text');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
