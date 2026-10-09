import { CrontickError } from './errors.js';
import { getEngineAdapter } from './engines/registry.js';
import { loadConfig } from './config.js';
import type { Job } from './schemas/job.js';
import {
  normalizeJobInput,
  normalizeJobPatch,
  type JobCreateInput,
  type JobPatchInput,
  type NormalizeJobInputOptions,
} from './job-input.js';

/**
 * Shared "input to finished Job" pipeline (normalize + Claude folder trust), used by
 * the client and the daemon. Internal: not exported from the public index.
 */

/** Looks a job up by id or alias; client = API lookup, daemon = `store.getJob`. Reserved for `after` resolution. */
export type ResolveJob = (idOrAlias: string) => Job | undefined;

export interface PrepareOptions extends NormalizeJobInputOptions {
  /** Trust untrusted folders instead of throwing TRUST_REQUIRED. */
  trustFolder?: boolean;
  resolveJob?: ResolveJob;
}

export interface TrustTarget {
  key: string;
  cwd: string;
  engine: string;
  adapter: ReturnType<typeof getEngineAdapter>;
}

export interface TrustContext {
  env?: NodeJS.ProcessEnv;
  /** Fallback folder when the job action has no cwd. */
  cwd?: string;
}

/** `engine|cwd` identity of what the trust check applies to, or undefined when the job's engine has no trust concept. */
export function trustTarget(job: Job, ctx: TrustContext = {}): TrustTarget | undefined {
  if (job.action.kind !== 'prompt') return undefined;
  const config = loadConfig({ env: ctx.env });
  const engine = job.action.engine ?? config.defaultEngine;
  const engineConfig = config.engines[engine];
  if (!engineConfig) return undefined;
  const adapter = getEngineAdapter(engineConfig.type);
  if (!adapter.isFolderTrusted || !adapter.trustFolder) return undefined;
  const cwd = job.action.cwd ?? ctx.cwd ?? process.cwd();
  return { key: `${engine}|${cwd}`, cwd, engine, adapter };
}

/**
 * Claude folder trust guardrail (engines without trust hooks are skipped).
 * Untrusted folders throw TRUST_REQUIRED before anything is persisted, unless
 * `trustFolder` is true, in which case they are trusted first. Distinct
 * folders are checked once each; details.folders lists every untrusted one.
 */
export function ensureFoldersTrusted(jobs: Job[], ctx: TrustContext, trustFolder: boolean): void {
  const env = ctx.env ?? process.env;
  const untrusted = new Map<string, TrustTarget>();
  for (const job of jobs) {
    const target = trustTarget(job, ctx);
    if (!target || untrusted.has(target.cwd)) continue;
    if (!target.adapter.isFolderTrusted!(target.cwd, { env })) untrusted.set(target.cwd, target);
  }
  if (untrusted.size === 0) return;
  const targets = [...untrusted.values()];
  if (!trustFolder) {
    const folders = targets.map((target) => target.cwd);
    const subject = folders.length === 1 ? `Folder ${folders[0]} is not` : `Folders ${folders.join(', ')} are not`;
    throw new CrontickError(
      'TRUST_REQUIRED',
      `${subject} trusted by Claude. Re-run with --trust-folder (CLI) or trustFolder: true (library/MCP) to trust ${folders.length === 1 ? 'it' : 'them'}. Agents: ask the user for permission first, then call again with trustFolder: true.`,
      { cwd: folders[0], folders, engine: targets[0]!.engine },
    );
  }
  for (const target of targets) target.adapter.trustFolder!(target.cwd, { env });
}

/** Normalizes a create input into a finished Job and enforces folder trust. */
export function prepareCreate(input: Job | JobCreateInput, options: PrepareOptions = {}): Job {
  const { trustFolder, resolveJob: _resolveJob, ...normalizeOptions } = options;
  void _resolveJob;
  const job = normalizeJobInput(input as JobCreateInput, normalizeOptions);
  ensureFoldersTrusted([job], { env: normalizeOptions.env, cwd: normalizeOptions.cwd }, trustFolder === true);
  return job;
}

/** Merges a patch over `existing`, re-validates, and enforces folder trust only when the engine/folder key changed. */
export function prepareUpdate(existing: Job, patch: JobPatchInput, options: PrepareOptions = {}): Job {
  const { trustFolder, resolveJob: _resolveJob, ...normalizeOptions } = options;
  void _resolveJob;
  const normalized = normalizeJobPatch(existing.id, existing, patch, normalizeOptions);
  const ctx = { env: normalizeOptions.env, cwd: normalizeOptions.cwd };
  if (trustTarget(existing, ctx)?.key !== trustTarget(normalized, ctx)?.key) {
    ensureFoldersTrusted([normalized], ctx, trustFolder === true);
  }
  return normalized;
}
