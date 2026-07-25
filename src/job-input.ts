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
  return {
    ...rest,
    prompt: prompt ?? readPromptFile(promptFile!, options),
  };
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
