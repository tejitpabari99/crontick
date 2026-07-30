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
const PromptActionInputSchema = PromptActionBaseSchema.omit({ prompt: true }).extend({
  prompt: z.string().min(1).optional(),
  promptFile: z.string().min(1).optional(),
}).strict();

const ActionInputSchema = z.discriminatedUnion('kind', [
  ScriptActionSchema,
  ExecActionSchema,
  PromptActionInputSchema,
]);

/**
 * Script action variant used only inside JobPatchInputSchema: `shell` has no
 * default here (unlike ScriptActionSchema, used for create). A patch's action
 * is validated as a whole object, so if `shell` defaulted to 'auto' whenever
 * omitted, an update that only changes `script` would zod-fill 'auto' and
 * normalizeJobPatch could never tell that apart from an explicit choice —
 * silently resetting a customized shell. Leaving it optional/undefined here
 * lets normalizeJobPatch merge it in from the existing action instead.
 */
const ScriptActionPatchSchema = ScriptActionSchema.extend({
  shell: z.enum(['auto', 'bash', 'pwsh', 'cmd']).optional(),
});

/**
 * Exec action variant used only inside JobPatchInputSchema: `args` has no
 * default here (unlike ExecActionSchema, used for create), for the same
 * reason as ScriptActionPatchSchema's `shell` — otherwise a patch that only
 * changes e.g. `envFile` would zod-fill `args` to `[]` and silently wipe out
 * existing exec arguments.
 */
const ExecActionPatchSchema = ExecActionSchema.extend({
  args: z.array(z.string()).optional(),
});

/**
 * Prompt action variant used only inside JobPatchInputSchema: `args` and
 * `reuseSession` have no default here (unlike PromptActionInputSchema, used
 * for create), for the same reason as above — a patch that only changes
 * `prompt` would otherwise zod-fill `args` to `[]` and `reuseSession` to
 * `false`, silently resetting both on every unrelated prompt update.
 */
const PromptActionPatchSchema = PromptActionInputSchema.extend({
  args: z.array(z.string()).optional(),
  reuseSession: z.boolean().optional(),
});

const ActionPatchInputSchema = z.discriminatedUnion('kind', [
  ScriptActionPatchSchema,
  ExecActionPatchSchema,
  PromptActionPatchSchema,
]);

export const JobCreateInputSchema = JobSchema.omit({ action: true }).extend({
  action: ActionInputSchema,
});

/**
 * Patch-only retry shape: unlike RetrySchema (used for create), both fields
 * are plain optional with no default — a partial retry patch (e.g. only
 * `max`) would otherwise zod-fill `backoffSec` back to 30 and silently reset
 * a customized backoff. normalizeJobPatch merges this onto the existing
 * retry value field-by-field, the same way it merges action patches.
 */
const RetryPatchSchema = z.object({
  max: z.number().int().min(0).optional(),
  backoffSec: z.number().positive().optional(),
});

export const JobPatchInputSchema = z.object({
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  schedule: ScheduleSchema.optional(),
  action: ActionPatchInputSchema.optional(),
  overlap: z.enum(['skip', 'queue', 'cancel-previous']).optional(),
  retry: RetryPatchSchema.optional(),
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
  /**
   * Explicit, repeatable `--arg <value>` values for --exec/--prompt actions.
   * This is the always-correct, shim-independent way to pass arguments: it
   * never depends on `--` surviving a Windows shim (crontick.ps1/crontick.cmd),
   * and never risks a crontick flag being swallowed as a literal argument.
   * Mutually exclusive with rawArgs/engineArgs (the `--` convention) — see
   * resolveActionArgs.
   */
  args?: string[];
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
  force?: boolean;
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
    action: normalizeActionInput(input.action, options, true),
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
  let normalizedPatch: JobPatchInput = patch;
  if (patch.action) {
    const merged = mergeActionPatch(existing.action, normalizeActionInput(patch.action, options, false));
    normalizedPatch = { ...normalizedPatch, action: withEngineDefaultForNewPromptAction(existing.action, merged, options) as ActionInput };
  }
  if (patch.retry) {
    normalizedPatch = { ...normalizedPatch, retry: mergeDefinedFields(existing.retry, patch.retry) as Job['retry'] };
  }
  const parsed = JobSchema.safeParse({ ...existing, ...normalizedPatch, id });
  if (!parsed.success) {
    throw new CrontickError('VALIDATION_ERROR', 'Invalid job', parsed.error.format());
  }
  return parsed.data;
}

/** Merges a patch object's defined fields onto a copy of the existing object,
 *  leaving fields the patch left `undefined` untouched. Shared by the action
 *  merge (mergeActionPatch) and the retry merge (normalizeJobPatch) — both
 *  exist because a create-time zod `.default()` had to be dropped from the
 *  matching patch schema (see ScriptActionPatchSchema/ExecActionPatchSchema/
 *  PromptActionPatchSchema/RetryPatchSchema), and the merge fills the gap
 *  left by an omitted field from the existing persisted value instead. */
function mergeDefinedFields(existing: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * A patch's action is merged field-by-field onto the existing action rather
 * than replacing it wholesale — otherwise fields the caller didn't mention
 * (shell, envFile, timeoutSec, args, reuseSession, ...) would be silently
 * discarded/reset every time any single action field is updated. A `kind`
 * change (e.g. script -> exec) is a deliberate full replacement: the old
 * action's fields don't apply to the new kind, so the patch action is used
 * as-is (and still gets zod's create-time defaults for shell/args/reuseSession
 * via the final JobSchema.safeParse below, since a kind change is effectively
 * a fresh action, same as create).
 */
function mergeActionPatch(existingAction: unknown, patchAction: unknown): unknown {
  if (!isRecord(existingAction) || !isRecord(patchAction) || existingAction.kind !== patchAction.kind) {
    return patchAction;
  }
  return mergeDefinedFields(existingAction, patchAction);
}

/**
 * Fills the configured default engine for a genuinely new prompt action
 * introduced via a kind-change patch (e.g. script -> prompt) that didn't
 * specify --engine. Same-kind prompt updates never need this: their engine
 * is already preserved by mergeActionPatch. This only fires when the
 * existing action was NOT already a prompt (a real kind change), so it
 * never overwrites an engine that mergeActionPatch already carried forward.
 */
function withEngineDefaultForNewPromptAction(
  existingAction: unknown,
  mergedAction: unknown,
  options: NormalizeJobInputOptions,
): unknown {
  const existingKind = isRecord(existingAction) ? existingAction.kind : undefined;
  if (
    !isRecord(mergedAction) ||
    mergedAction.kind !== 'prompt' ||
    existingKind === 'prompt' ||
    mergedAction.engine !== undefined
  ) {
    return mergedAction;
  }
  return { ...mergedAction, engine: loadConfig({ env: options.env }).defaultEngine };
}

/**
 * Resolves the effective args for --exec/--prompt actions from the two
 * mutually exclusive CLI sources: explicit repeatable `--arg <value>` flags
 * (always correct, shim-independent) and legacy `--` positional args (a
 * convenience that only survives intact on invocations where the shell/shim
 * doesn't mangle it — see cli/index.ts's --exec help text). Combining both in
 * the same command is rejected rather than silently picking one, since that
 * combination is never what the user intended.
 */
function resolveActionArgs(input: JobPatchCliOptions): string[] {
  const rawArgs = input.rawArgs ?? input.engineArgs ?? [];
  const explicitArgs = input.args ?? [];
  if (rawArgs.length > 0 && explicitArgs.length > 0) {
    throw new CrontickError(
      'VALIDATION_ERROR',
      'Cannot combine --arg with -- positional arguments in the same command. Use repeatable --arg <value> (always correct) or -- (convenience) but not both.',
    );
  }
  return explicitArgs.length > 0 ? explicitArgs : rawArgs;
}

/** Constructs a full Job from CLI flags; supports --file (JSON) as an alternative to flags. */
export function buildJobFromCreateOptions(
  input: JobCreateCliOptions,
  options: NormalizeJobInputOptions = {},
): Job {
  const resolvedArgs = resolveActionArgs(input);
  if (input.file) {
    assertFileModeExclusive(input, resolvedArgs);
    const filePath = resolve(options.cwd ?? process.cwd(), input.file);
    const raw = readFileSync(filePath, 'utf-8');
    return normalizeJobInput(JSON.parse(raw) as JobCreateInput, {
      ...options,
      fileBaseDir: dirname(filePath),
    });
  }

  const jobData = {
    id: input.id,
    description: input.desc,
    enabled: input.enabled,
    schedule: buildSchedule(input),
    action: buildAction(input, resolvedArgs),
    overlap: (input.overlap ?? 'skip') as JobCreateInput['overlap'],
    retry: input.retry !== undefined ? { max: input.retry, backoffSec: 30 } : undefined,
  } satisfies JobCreateInput;
  return normalizeJobInput(jobData, options);
}

export function buildJobPatchFromUpdateOptions(
  input: JobPatchCliOptions,
  options: NormalizeJobInputOptions = {},
): JobPatchInput {
  const resolvedArgs = resolveActionArgs(input);
  if (input.file) {
    assertFileModeExclusive(input, resolvedArgs);
    const filePath = resolve(options.cwd ?? process.cwd(), input.file);
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JobPatchInputSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new CrontickError('VALIDATION_ERROR', 'Invalid job patch', parsed.error.format());
    return parsed.data.action
      ? { ...parsed.data, action: normalizeActionInput(parsed.data.action, { ...options, fileBaseDir: dirname(filePath) }, false) as ActionInput }
      : parsed.data;
  }

  const patch: JobPatchInput = {};
  if (input.desc !== undefined) patch.description = input.desc;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  const schedule = maybeBuildSchedule(input);
  if (schedule !== undefined) patch.schedule = schedule;
  const action = maybeBuildAction(input, resolvedArgs);
  if (action !== undefined) patch.action = normalizeActionInput(action, options, false) as ActionInput;
  // Commander no longer supplies a hardcoded default for --overlap (see
  // commonJobOptions in cli/index.ts), so `undefined` unambiguously means
  // "not provided" here — overlap is treated like any other optional field.
  if (input.overlap !== undefined) patch.overlap = input.overlap as JobPatchInput['overlap'];
  if (input.retry !== undefined) patch.retry = { max: input.retry, backoffSec: 30 };

  const parsed = JobPatchInputSchema.safeParse(patch);
  if (!parsed.success) throw new CrontickError('VALIDATION_ERROR', 'Invalid job patch', parsed.error.format());
  return parsed.data;
}

/**
 * Normalizes a prompt action input: resolves promptFile, fills engine default,
 * clears redundant reuseSession, and runs runtime validation.
 *
 * `isCreate` gates the engine default fill: `engine` has no zod-level
 * default (see PromptEngineSchema usage in schemas/job.ts), so unlike
 * shell/args/reuseSession it can't fall back on the final JobSchema parse.
 * On create, an omitted engine should resolve to the configured default. On
 * a patch (isCreate: false), filling it here would stamp the config default
 * onto every same-kind prompt update that doesn't mention --engine, wiping
 * out a job's existing custom engine. normalizeJobPatch instead merges the
 * patch action onto the existing action (preserving engine), and only calls
 * withEngineDefaultForNewPromptAction to fill it for a genuine kind-change
 * into 'prompt' (which has no existing engine to preserve).
 */
function normalizeActionInput(action: ActionInput, options: NormalizeJobInputOptions, isCreate: boolean): unknown {
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
  if (isCreate && normalized.engine === undefined) {
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
  // --exec reuses the same args convention prompt mode already uses: the
  // command is taken verbatim (no whitespace splitting) and its arguments
  // come from repeatable --arg <value> flags (always correct) or, as a
  // convenience, everything after `--` (see resolveActionArgs).
  const rawArgsMode = promptMode || input.exec !== undefined;
  if (!rawArgsMode && rawArgs.length > 0) {
    throw new CrontickError(
      'VALIDATION_ERROR',
      'Arguments (via --arg or --) are valid only with --exec, --prompt, or --prompt-file. Remove them or use one of those action sources.',
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
    return {
      kind: 'exec',
      command: input.exec, // taken verbatim -- no whitespace splitting
      args: rawArgs, // everything after `--`, same convention as prompt mode
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
    || opts.shell !== undefined
    || opts.envFile !== undefined
    || opts.timeout !== undefined
    || opts.overlap !== undefined
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

function actionShell(shell: string | undefined): 'auto' | 'bash' | 'pwsh' | 'cmd' | undefined {
  if (shell === undefined) return undefined;
  if (shell === 'bash' || shell === 'pwsh' || shell === 'cmd' || shell === 'auto') return shell;
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
