import { readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { CrontickError } from './errors.js';
import {
  ExecActionSchema,
  JobSchema,
  PromptActionSchema,
  ScriptActionSchema,
  type Job,
  type JobInput,
} from './schemas/job.js';

export type PromptActionInput = Omit<z.input<typeof PromptActionSchema>, 'prompt'> & {
  prompt?: string;
  promptFile?: string;
};

export type ActionInput =
  | z.input<typeof ScriptActionSchema>
  | z.input<typeof ExecActionSchema>
  | PromptActionInput;

export type JobCreateInput = Omit<JobInput, 'action'> & { action: ActionInput };

export interface NormalizeJobInputOptions {
  cwd?: string;
  fileBaseDir?: string;
  maxPromptFileBytes?: number;
}

const DEFAULT_MAX_PROMPT_FILE_BYTES = 1024 * 1024;
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
  const normalized = {
    ...rest,
    prompt: prompt ?? readPromptFile(promptFile!, options),
  };
  validatePromptActionRuntimeArgs(normalized);
  return {
    ...normalized,
  };
}

function validatePromptActionRuntimeArgs(action: Record<string, unknown>): void {
  const args = Array.isArray(action.args) ? action.args : [];
  const reserved = args.find((arg) => typeof arg === 'string' && isReservedPromptArg(arg));
  if (reserved) {
    throw new CrontickError(
      'VALIDATION_ERROR',
      `Raw prompt engine args cannot include crontick-managed prompt/session flag: ${reserved}`,
    );
  }

  const prompt = typeof action.prompt === 'string' ? action.prompt : '';
  const sessionId = typeof action.sessionId === 'string' ? action.sessionId : undefined;
  const engine = action.engine === 'agency' ? 'agency' : 'copilot';
  const argv =
    engine === 'agency'
      ? ['agency', 'cp', `--prompt=${prompt}`, ...args.filter(isString)]
      : ['copilot', `--prompt=${prompt}`, ...args.filter(isString)];
  if (sessionId) argv.push(`--session-id=${sessionId}`);

  const estimatedLength = estimateWindowsCommandLineLength(argv);
  if (estimatedLength > SAFE_PROMPT_COMMAND_LINE_LIMIT) {
    throw new CrontickError(
      'VALIDATION_ERROR',
      `Prompt plus engine arguments exceed the Windows-safe command line limit (${estimatedLength}/${WINDOWS_COMMAND_LINE_LIMIT} characters). Shorten the prompt or arguments.`,
    );
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
