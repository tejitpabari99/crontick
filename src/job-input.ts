/**
 * Job input normalization and CLI-to-job construction. This module converts
 * user-friendly input shapes (promptFile, CLI flags, partial patches) into the
 * canonical persisted Job shape. Key transformations:
 * - `promptFile` is read from disk and becomes `prompt` (never persisted as path)
 * - Engine defaults are resolved from config when not specified
 * - `reuseSession` is cleared when an explicit `sessionId` is already set
 * - Prompt runtime validation (Windows cmd-line length, reserved args) is applied
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { CrontickError } from './errors.js';
import {
  JOB_ALIAS_PATTERN,
  JobBaseSchema,
  JobSchema,
  PromptActionBaseSchema,
  ScheduleSchema,
  type Job,
  type JobInput,
} from './schemas/job.js';
import { EngineNameSchema, type CrontickConfig } from './schemas/config.js';
import { loadConfig } from './config.js';
import { readJsonFile } from './json-file.js';
import { promptRuntimeValidationMessage } from './prompt-runtime.js';
import { DEFAULT_MAX_PROMPT_FILE_BYTES } from './constants/job-input.js';

/**
 * Input schema extends prompt action to accept `promptFile` as an alternative
 * to `prompt`. During normalization, the file is read and inlined.
 */
const PromptActionInputSchema = PromptActionBaseSchema.omit({ prompt: true }).extend({
  prompt: z.string().min(1).optional(),
  promptFile: z.string().min(1).optional(),
}).strict();

const ActionInputSchema = z.discriminatedUnion('kind', [
  PromptActionInputSchema,
]);

/**
 * Prompt action variant used only inside JobPatchInputSchema: `args` and
 * `reuseSession` have no default here (unlike PromptActionInputSchema, used
 * for create), for the same reason as above — a patch that only changes
 * `prompt` would otherwise zod-fill `args` to `[]` and `reuseSession` to
 * `false`, silently resetting both on every unrelated prompt update.
 */
const PromptActionPatchSchema = PromptActionInputSchema.extend({
  prompt: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  reuseSession: z.boolean().optional(),
});

const ActionPatchInputSchema = z.discriminatedUnion('kind', [
  PromptActionPatchSchema,
]);

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

/** Create inputs must leave missing policy fields absent until config defaults are applied. */
export const JobCreateInputSchema = JobBaseSchema.omit({ action: true }).extend({
  action: ActionInputSchema,
  overlap: z.enum(['skip', 'queue', 'cancel-previous']).optional(),
  retry: RetryPatchSchema.optional(),
});

/** One job inside a share export file: a create input whose `id` (if present) is ignored; every import assigns a new GUID. */
export const ImportJobSchema = JobCreateInputSchema.extend({ id: z.string().optional() });

/** Share export/import file, format version 1 (jobs only; no run history, no ids on export). */
export const ExportFileSchema = z.object({
  schema: z.literal(1),
  exportedAt: z.string().optional(),
  crontickVersion: z.string().optional(),
  jobs: z.array(ImportJobSchema),
});

export type ExportFile = { schema: 1; exportedAt?: string; crontickVersion?: string; jobs: Array<Omit<Job, 'id'>> };

export const JobPatchInputSchema = z.object({
  /** Alias is user-editable after creation; `id` (the GUID) is never patchable. */
  alias: z.string().regex(JOB_ALIAS_PATTERN, 'Job alias must be kebab-case (e.g. "my-job")').optional().describe('Unique kebab-case job alias (set via CLI --name)'),
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
  /** Explicit job alias (CLI `--name`/`-n`) on create; the only way to name a job. When omitted, one is auto-generated (see generateAlias). Also the only way to rename a job's alias on update. */
  alias?: string;
  engineArgs?: string[];
  rawArgs?: string[];
  /** Unknown long-form CLI flags and their values, kept in argv order. */
  passthroughArgs?: string[];
  /** Original order when the CLI interleaves positional and unknown-flag tokens. */
  cliArgvOrder?: string[];
  /**
   * Explicit, repeatable `--arg <value>` values for prompt actions.
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
  /** Working directory the engine runs in (`--cwd`/`-C`); stored as `action.cwd`. Defaults to the invoking directory on create. */
  cwd?: string;
  /** Trust the job's working directory in Claude without asking (`--trust-folder`). */
  trustFolder?: boolean;
  prompt?: string;
  promptFile?: string;
  engine?: string;
  sessionId?: string;
  reuseSession?: boolean;
  envFile?: string;
  timeout?: number;
  overlap?: string;
  retry?: number;
  desc?: string;
  enabled?: boolean;
  /** CLI `--enable` flag (update only). Mutually exclusive with `disable`; resolved to `enabled` by buildJobPatchFromUpdateOptions. */
  enable?: boolean;
  /** CLI `--disable` flag (update only). Mutually exclusive with `enable`. */
  disable?: boolean;
  force?: boolean;
}

export type JobPatchCliOptions = JobCreateCliOptions;

/**
 * Cron schedules fire in the machine local timezone; the `tz` field was removed.
 * Rejecting it on new input beats silently stripping a timezone the caller
 * expected to apply. (Legacy stored jobs that still carry `tz` are tolerated:
 * their `tz` is ignored and the daemon warns once per job at startup.)
 */
function assertNoScheduleTimezone(schedule: unknown): void {
  if (isRecord(schedule) && 'tz' in schedule && schedule['tz'] !== undefined) {
    throw new CrontickError(
      'VALIDATION_ERROR',
      'schedule.tz is no longer supported: cron schedules fire in the machine local timezone. Remove tz from the schedule.',
    );
  }
}

/** Validates and normalizes a full job create input into the canonical persisted shape. */
export function normalizeJobInput(
  input: JobCreateInput,
  options: NormalizeJobInputOptions = {},
): Job {
  assertNoScheduleTimezone(input.schedule);
  const config = loadConfig({ env: options.env });
  const normalized = {
    ...input,
    overlap: input.overlap ?? config.defaults.overlap,
    retry: {
      max: input.retry?.max ?? config.defaults.retry.max,
      backoffSec: input.retry?.backoffSec ?? config.defaults.retry.backoffSec,
    },
    action: normalizeActionInput(input.action, options, true, config),
  };

  const parsed = JobSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new CrontickError('VALIDATION_ERROR', 'Invalid job', parsed.error.format());
  }
  return parsed.data;
}

/**
 * Built-in word list used to auto-generate a job alias when the caller
 * doesn't supply one (see generateAlias). Deliberately small and simple
 * (short nouns), not meant to be exhaustive -- collision avoidance comes
 * from combining a word with a random 1-1000 suffix and retrying on
 * collision, not from the size of the word list itself.
 */
export const DEFAULT_ALIAS_WORDS: readonly string[] = [
  'atlas', 'aurora', 'birch', 'comet', 'cove', 'dune', 'ember', 'falcon',
  'fern', 'harbor', 'juniper', 'lumen', 'meadow', 'nimbus', 'orbit', 'pixel',
  'quartz', 'raven', 'reef', 'summit', 'tundra', 'vale', 'willow', 'zephyr',
];

const MAX_ALIAS_GENERATION_ATTEMPTS = 50;
const ALIAS_FALLBACK_ATTEMPTS = 5;

export interface GenerateAliasOptions {
  /** Word list to draw the alias prefix from. Defaults to DEFAULT_ALIAS_WORDS. Injectable so tests can control output deterministically. */
  words?: readonly string[];
  /** Returns a float in [0, 1); defaults to Math.random. Injectable for deterministic tests. */
  random?: () => number;
}

/**
 * Auto-generates a unique job alias: `<word>-<1-1000>`, retrying on
 * collision. `isTaken` is injected (checked against currently-live jobs by
 * id AND alias) so this module has no direct dependency on the store.
 */
export function generateAlias(isTaken: (candidate: string) => boolean, options: GenerateAliasOptions = {}): string {
  const words = options.words && options.words.length > 0 ? options.words : DEFAULT_ALIAS_WORDS;
  const random = options.random ?? Math.random;
  for (let attempt = 0; attempt < MAX_ALIAS_GENERATION_ATTEMPTS; attempt++) {
    const word = words[Math.floor(random() * words.length)];
    const suffix = 1 + Math.floor(random() * 1000);
    const candidate = `${word}-${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
  // Numeric suffixes exhausted: fall back to a short random base36 suffix, which
  // has a vastly larger space (36^6), before giving up.
  for (let attempt = 0; attempt < ALIAS_FALLBACK_ATTEMPTS; attempt++) {
    const word = words[Math.floor(random() * words.length)];
    const suffix = Number.parseInt(randomUUID().replace(/-/g, '').slice(0, 8), 16).toString(36).padStart(6, '0').slice(-6);
    const candidate = `${word}-${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new CrontickError(
    'ALIAS_GENERATION_FAILED',
    `Could not generate a unique job alias after ${MAX_ALIAS_GENERATION_ATTEMPTS + ALIAS_FALLBACK_ATTEMPTS} attempts. Provide an explicit alias.`,
  );
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
  assertNoScheduleTimezone(patch.schedule);
  const parsedPatch = JobPatchInputSchema.safeParse(patch);
  if (!parsedPatch.success) throw new CrontickError('VALIDATION_ERROR', 'Invalid job patch', parsedPatch.error.format());

  let normalizedPatch: JobPatchInput = parsedPatch.data;
  if (patch.action) {
    const normalizedAction = normalizeActionInput(patch.action as ActionInput, options, false);
    let merged = mergeActionPatch(existing.action, normalizedAction);
    merged = applyCwdSessionRule(existing.action, normalizedAction, merged);
    normalizedPatch = { ...normalizedPatch, action: withEngineDefaultForNewPromptAction(existing.action, merged, options) as ActionInput };
  }
  if (patch.retry) {
    normalizedPatch = { ...normalizedPatch, retry: mergeDefinedFields(existing.retry, patch.retry) as Job['retry'] };
  }
  const parsed = JobSchema.safeParse({ ...existing, ...normalizedPatch, id: existing.id });
  if (!parsed.success) {
    throw new CrontickError('VALIDATION_ERROR', 'Invalid job', parsed.error.format());
  }
  return parsed.data;
}

/**
 * Claude sessions are keyed by working directory, so a stored session cannot
 * follow a job to a different cwd. When a patch moves a job that has a session
 * (explicit `sessionId`, or `reuseSession` state) to another directory, require
 * the caller to say what happens to the session: give a new `sessionId`, or pass
 * `reuseSession: true` to start a fresh session in the new directory (which
 * drops the stored one). Anything else would silently break resume.
 */
function applyCwdSessionRule(existingAction: unknown, patchAction: unknown, merged: unknown): unknown {
  if (!isRecord(existingAction) || !isRecord(patchAction) || !isRecord(merged)) return merged;
  if (existingAction.kind !== 'prompt' || typeof patchAction.cwd !== 'string') return merged;
  const cwdChanged = patchAction.cwd !== existingAction.cwd;
  const hasSession = typeof existingAction.sessionId === 'string' || existingAction.reuseSession === true;
  if (!cwdChanged || !hasSession) return merged;
  const newSession = typeof patchAction.sessionId === 'string';
  const resetSession = patchAction.reuseSession === true;
  if (!newSession && !resetSession) {
    throw new CrontickError(
      'CWD_CHANGE_BREAKS_SESSION',
      `Changing the working directory of a job that has a session (sessionId/reuseSession) would break resume: Claude sessions are stored per directory. Also pass --session-id <id> for a session that exists in the new directory, or --reuse-session to start a fresh session there.`,
      { from: existingAction.cwd, to: patchAction.cwd },
    );
  }
  if (resetSession && !newSession) {
    const { sessionId: _dropped, ...rest } = merged;
    void _dropped;
    return rest;
  }
  return merged;
}

/** Merges a patch object's defined fields onto a copy of the existing object,
 *  leaving fields the patch left `undefined` untouched. Shared by the action
 *  merge (mergeActionPatch) and the retry merge (normalizeJobPatch) — both
 *  exist because a create-time zod `.default()` had to be dropped from the
 *  matching patch schema (see PromptActionPatchSchema/RetryPatchSchema), and
 *  the merge fills the gap left by an omitted field from the existing
 *  persisted value instead. */
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
 * (envFile, timeoutSec, args, reuseSession, ...) would be silently
 * discarded/reset every time any single action field is updated. `prompt` is
 * currently the only action kind, so the `kind` mismatch branch below is
 * unreachable in practice; it's kept as a defensive fallback (full
 * replacement, same as create) in case a future action kind is added.
 */
function mergeActionPatch(existingAction: unknown, patchAction: unknown): unknown {
  if (!isRecord(existingAction) || !isRecord(patchAction) || existingAction.kind !== patchAction.kind) {
    return patchAction;
  }
  return mergeDefinedFields(existingAction, patchAction);
}

/**
 * Fills the configured default engine for a genuinely new prompt action
 * introduced via a kind-change patch that didn't specify --runner. Same-kind
 * prompt updates never need this: their engine is already preserved by
 * mergeActionPatch. This only fires when the existing action was NOT already
 * a prompt (a real kind change), so it never overwrites an engine that
 * mergeActionPatch already carried forward.
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
 * Resolves the effective args for prompt actions from the two
 * mutually exclusive CLI sources: explicit repeatable `--arg <value>` flags
 * (always correct, shim-independent) and legacy `--` positional args (a
 * convenience that only survives intact on invocations where the shell/shim
 * doesn't mangle it). Combining both in
 * the same command is rejected rather than silently picking one, since that
 * combination is never what the user intended. Unknown long-form flags are
 * independent and follow either source in the stored argument list.
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
  if (explicitArgs.length === 0 && input.cliArgvOrder) return input.cliArgvOrder;
  return [...(explicitArgs.length > 0 ? explicitArgs : rawArgs), ...(input.passthroughArgs ?? [])];
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
    return normalizeJobInput(readJsonFile(filePath, {
      errorCode: 'VALIDATION_ERROR',
      subject: 'job definition file',
      expectedShape: 'expected a JSON object matching the crontick job schema',
    }) as JobCreateInput, {
      ...options,
      fileBaseDir: dirname(filePath),
    });
  }

  const jobData = {
    alias: input.alias,
    description: input.desc,
    enabled: input.enabled,
    schedule: buildSchedule(input),
    action: buildAction(input, resolvedArgs),
    overlap: input.overlap as JobCreateInput['overlap'],
    retry: input.retry !== undefined ? { max: input.retry } : undefined,
  } satisfies JobCreateInput;
  return normalizeJobInput(jobData, options);
}

export function buildJobPatchFromUpdateOptions(
  input: JobPatchCliOptions,
  options: NormalizeJobInputOptions = {},
): JobPatchInput {
  // Domain rule enforced in core (not the CLI shim): --enable and --disable
  // are mutually exclusive. Resolved to a single `enabled` boolean below.
  if (input.enable && input.disable) {
    throw new CrontickError('VALIDATION_ERROR', '--enable and --disable are mutually exclusive');
  }
  const enabled = input.enabled ?? (input.enable ? true : input.disable ? false : undefined);
  const resolvedArgs = resolveActionArgs(input);
  if (input.file) {
    assertFileModeExclusive(input, resolvedArgs);
    const filePath = resolve(options.cwd ?? process.cwd(), input.file);
    const parsed = JobPatchInputSchema.safeParse(readJsonFile(filePath, {
      errorCode: 'VALIDATION_ERROR',
      subject: 'job patch file',
      expectedShape: 'expected a JSON object matching the crontick job patch schema',
    }));
    if (!parsed.success) throw new CrontickError('VALIDATION_ERROR', 'Invalid job patch', parsed.error.format());
    return parsed.data.action
      ? { ...parsed.data, action: normalizeActionInput(parsed.data.action as ActionInput, { ...options, fileBaseDir: dirname(filePath) }, false) as ActionInput }
      : parsed.data;
  }

  const patch: JobPatchInput = {};
  if (input.alias !== undefined) patch.alias = input.alias;
  if (input.desc !== undefined) patch.description = input.desc;
  if (enabled !== undefined) patch.enabled = enabled;
  const schedule = maybeBuildSchedule(input);
  if (schedule !== undefined) patch.schedule = schedule;
  const action = maybeBuildAction(input, resolvedArgs, true);
  if (action !== undefined) patch.action = normalizeActionInput(action, options, false) as ActionInput;
  // Commander no longer supplies a hardcoded default for --overlap (see
  // commonJobOptions in cli/index.ts), so `undefined` unambiguously means
  // "not provided" here — overlap is treated like any other optional field.
  if (input.overlap !== undefined) patch.overlap = input.overlap as JobPatchInput['overlap'];
  if (input.retry !== undefined) patch.retry = { max: input.retry };

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
 * args/reuseSession it can't fall back on the final JobSchema parse.
 * On create, an omitted engine should resolve to the configured default. On
 * a patch (isCreate: false), filling it here would stamp the config default
 * onto every same-kind prompt update that doesn't mention --runner, wiping
 * out a job's existing custom engine. normalizeJobPatch instead merges the
 * patch action onto the existing action (preserving engine), and only calls
 * withEngineDefaultForNewPromptAction to fill it for a genuine kind-change
 * into 'prompt' (which has no existing engine to preserve).
 */
function normalizeActionInput(action: ActionInput, options: NormalizeJobInputOptions, isCreate: boolean, config?: CrontickConfig): unknown {
  if (!isRecord(action) || action.kind !== 'prompt') return action;
  action = withResolvedCwd(action, options, isCreate);

  const prompt = typeof action.prompt === 'string' ? action.prompt : undefined;
  const promptFile = typeof action.promptFile === 'string' ? action.promptFile : undefined;
  // On a patch (isCreate=false) with no prompt/promptFile, the source is preserved
  // by mergeActionPatch — skip the full normalization path that requires exactly one source.
  // However, some invariants still apply to source-free patches: clear reuseSession when a
  // sessionId is patched in (B-2 invariant), and validate args if present (C-1).
  if (!isCreate && prompt === undefined && promptFile === undefined) {
    let result = action as unknown as Record<string, unknown>;
    if (typeof result['sessionId'] === 'string') {
      // Always include reuseSession:false in the patch result so that mergeDefinedFields
      // propagates it to the merged job even when the existing job has reuseSession:true
      // (the invariant: a job cannot have both sessionId and reuseSession:true).
      if (result['reuseSession'] !== false) {
        options.onNotice?.(
          'reuseSession was ignored because an explicit sessionId was provided; crontick will reuse the explicit session id.',
        );
        result = { ...result, reuseSession: false };
      }
    }
    // Route args-only patches through runtime arg validation so reserved-arg / cmdline-length
    // errors are caught at patch time rather than deferred to execution.
    if (Array.isArray(result['args'])) {
      validatePromptActionRuntimeArgs(result);
    }
    return result;
  }
  if ((prompt ? 1 : 0) + (promptFile ? 1 : 0) !== 1) {
    throw new CrontickError(
      'VALIDATION_ERROR',
      'Prompt jobs require exactly one of prompt or promptFile',
    );
  }

  const { promptFile: _promptFile, ...rest } = action;
  void _promptFile;
  const effectiveConfig = isCreate ? config ?? loadConfig({ env: options.env }) : undefined;
  let normalized = {
    ...rest,
    prompt: prompt ?? readPromptFile(promptFile!, options),
    ...(isCreate && rest.timeoutSec === undefined && effectiveConfig?.defaults.timeoutSec !== undefined
      ? { timeoutSec: effectiveConfig.defaults.timeoutSec }
      : {}),
  };
  if (isCreate && normalized.engine === undefined) {
    normalized = {
      ...normalized,
      engine: effectiveConfig!.defaultEngine,
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

/**
 * Resolves `action.cwd` to an absolute, existing directory (relative values
 * resolve against the caller's cwd). On create an omitted cwd defaults to the
 * caller's cwd, so a job always records where it was created; on a patch an
 * omitted cwd stays untouched. The runner re-checks the directory at spawn time.
 */
function withResolvedCwd(action: ActionInput, options: NormalizeJobInputOptions, isCreate: boolean): ActionInput {
  const base = options.cwd ?? process.cwd();
  const requested = typeof action.cwd === 'string' && action.cwd.length > 0 ? action.cwd : undefined;
  if (requested === undefined && !isCreate) return action;
  const resolved = resolve(base, requested ?? '.');
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    throw new CrontickError('INVALID_CWD', `Working directory does not exist: ${resolved}. Pass an existing directory with --cwd/-C (or action.cwd).`, { cwd: resolved });
  }
  if (!stat.isDirectory()) {
    throw new CrontickError('INVALID_CWD', `Working directory is not a directory: ${resolved}. Pass an existing directory with --cwd/-C (or action.cwd).`, { cwd: resolved });
  }
  return { ...action, cwd: resolved } as ActionInput;
}

function validatePromptActionRuntimeArgs(action: Record<string, unknown>): void {
  const args = Array.isArray(action.args) ? action.args.filter(isString) : [];
  const message = promptRuntimeValidationMessage({
    prompt: typeof action.prompt === 'string' ? action.prompt : '',
    engine: typeof action.engine === 'string' ? action.engine : 'claude',
    args,
    sessionId: typeof action.sessionId === 'string' ? action.sessionId : undefined,
  });
  if (message) throw new CrontickError('VALIDATION_ERROR', message);
}

function standaloneActionModifierFlags(input: JobPatchCliOptions): string[] {
  const flags: string[] = [];
  if (input.envFile !== undefined) flags.push(`--job-env-file ${JSON.stringify(input.envFile)}`);
  if (input.timeout !== undefined) flags.push('--timeout');
  return flags;
}

function formatCliFlagList(flags: readonly string[]): string {
  if (flags.length === 1) return flags[0]!;
  if (flags.length === 2) return `${flags[0]} and ${flags[1]}`;
  return `${flags.slice(0, -1).join(', ')}, and ${flags.at(-1)}`;
}

function buildSchedule(input: JobCreateCliOptions): JobCreateInput['schedule'] {
  const schedule = maybeBuildSchedule(input);
  if (!schedule) throw new CrontickError('MISSING_ARG', 'Provide exactly one schedule: --cron <expr>, --every <interval> (seconds, or a s/m/h/d suffix such as 30m), or --at <datetime> (one-shot ISO-8601 time, local timezone unless an offset is given)');
  return schedule;
}

function maybeBuildSchedule(input: JobPatchCliOptions): JobCreateInput['schedule'] | undefined {
  const count = [input.cron, input.every, input.at].filter((value) => value !== undefined).length;
  if (count === 0) return undefined;
  if (count > 1) throw new CrontickError('VALIDATION_ERROR', 'Provide only one schedule: --cron, --every, or --at (they cannot be combined)');
  if (input.cron !== undefined) return { kind: 'cron', cron: input.cron };
  if (input.every !== undefined) return { kind: 'interval', everySec: input.every };
  if (input.at !== undefined) return { kind: 'one-shot', runAt: input.at };
  return undefined;
}

function buildAction(input: JobCreateCliOptions, rawArgs: string[]): ActionInput {
  const action = maybeBuildAction(input, rawArgs);
  if (!action) throw new CrontickError('MISSING_ARG', 'Provide --prompt or --prompt-file for a prompt job, or --file <json> for a full job definition');
  return action;
}

function maybeBuildAction(input: JobPatchCliOptions, rawArgs: string[], strictUpdate = false): ActionInput | undefined {
  const actionSourceCount = [input.prompt, input.promptFile].filter(
    (value) => value !== undefined,
  ).length;
  if (actionSourceCount === 0) {
    const modifierFlags = standaloneActionModifierFlags(input);
    if (strictUpdate && modifierFlags.length > 0) {
      throw new CrontickError(
        'VALIDATION_ERROR',
        `${formatCliFlagList(modifierFlags)} ${modifierFlags.length === 1 ? 'requires' : 'require'} an action source on update. Repeat the existing action with --prompt or --prompt-file, or remove ${formatCliFlagList(modifierFlags)}.`,
      );
    }
    if (rawArgs.length > 0) {
      throw new CrontickError(
        'VALIDATION_ERROR',
        'Arguments (via --arg or --) are valid only with --prompt or --prompt-file. Remove them or use one of those action sources.',
      );
    }
    if (strictUpdate && input.cwd !== undefined) {
      // `jobs update --cwd` changes only the working directory (and, with
      // --session-id / --reuse-session, the session handling that must go with it).
      return { kind: 'prompt', cwd: input.cwd, sessionId: input.sessionId, reuseSession: input.reuseSession, engine: promptEngine(input.engine) };
    }
    if (input.engine !== undefined || input.sessionId !== undefined || input.reuseSession) {
      throw new CrontickError(
        'VALIDATION_ERROR',
        'Prompt engine/session flags are valid only with prompt mode. Use --prompt or --prompt-file, or remove --runner/--session-id/--reuse-session.',
      );
    }
    return undefined;
  }
  if (actionSourceCount !== 1) {
    throw new CrontickError(
      'MISSING_ARG',
      'Provide exactly one action source: --prompt or --prompt-file',
    );
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
    cwd: input.cwd,
  };
}

/** --file is mutually exclusive with all other schedule/action/prompt flags. */
function assertFileModeExclusive(opts: JobPatchCliOptions, rawArgs: string[]): void {
  const conflicting = rawArgs.length > 0
    || opts.cron !== undefined
    || opts.every !== undefined
    || opts.at !== undefined
    || opts.cwd !== undefined
    || opts.prompt !== undefined
    || opts.promptFile !== undefined
    || opts.engine !== undefined
    || opts.sessionId !== undefined
    || opts.reuseSession !== undefined
    || opts.envFile !== undefined
    || opts.timeout !== undefined
    || opts.overlap !== undefined
    || opts.retry !== undefined
    || opts.desc !== undefined
    || opts.enabled !== undefined
    || opts.alias !== undefined;

  if (conflicting) {
    throw new CrontickError(
      'VALIDATION_ERROR',
      '--file is mutually exclusive with schedule, action, prompt, session, and raw engine arguments',
    );
  }
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
