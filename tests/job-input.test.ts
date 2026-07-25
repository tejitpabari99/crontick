import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeJobInput, type ActionInput, type JobCreateInput } from '../src/job-input.js';
import { JobSchema } from '../src/schemas/job.js';

const scratchRoot = resolve('.crontick', 'job-input-tests');
const cleanupDirs: string[] = [];

function makeDir(): string {
  const dir = join(scratchRoot, randomUUID());
  mkdirSync(dir, { recursive: true });
  cleanupDirs.push(dir);
  return dir;
}

function baseJob(action: unknown): JobCreateInput {
  return {
    id: 'prompt-job',
    schedule: { kind: 'cron' as const, cron: '0 9 * * *' },
    action: action as ActionInput,
  };
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('normalizeJobInput', () => {
  it('normalizes prompt text jobs with defaults', () => {
    const job = normalizeJobInput(baseJob({ kind: 'prompt', prompt: 'Summarize' }));
    expect(job.action).toEqual({
      kind: 'prompt',
      prompt: 'Summarize',
      engine: 'copilot',
      args: [],
      reuseSession: false,
    });
  });

  it('reads .txt promptFile into prompt and does not persist promptFile', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'prompt.txt'), 'from file', 'utf-8');

    const job = normalizeJobInput(
      baseJob({ kind: 'prompt', promptFile: 'prompt.txt', engine: 'agency' }),
      { fileBaseDir: dir },
    );

    expect(job.action).toMatchObject({ kind: 'prompt', prompt: 'from file', engine: 'agency' });
    expect(job.action).not.toHaveProperty('promptFile');
  });

  it('accepts .TXT promptFile extension case-insensitively', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'PROMPT.TXT'), 'upper', 'utf-8');
    const job = normalizeJobInput(baseJob({ kind: 'prompt', promptFile: 'PROMPT.TXT' }), {
      fileBaseDir: dir,
    });
    expect(job.action).toMatchObject({ kind: 'prompt', prompt: 'upper' });
  });

  it('rejects non-.txt prompt files, directories, and oversize files', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'prompt.md'), 'markdown', 'utf-8');
    mkdirSync(join(dir, 'folder.txt'));
    writeFileSync(join(dir, 'big.txt'), 'too big', 'utf-8');

    expect(() =>
      normalizeJobInput(baseJob({ kind: 'prompt', promptFile: 'prompt.md' }), { fileBaseDir: dir }),
    ).toThrow(/\.txt/);
    expect(() =>
      normalizeJobInput(baseJob({ kind: 'prompt', promptFile: 'folder.txt' }), { fileBaseDir: dir }),
    ).toThrow(/regular/);
    expect(() =>
      normalizeJobInput(baseJob({ kind: 'prompt', promptFile: 'big.txt' }), {
        fileBaseDir: dir,
        maxPromptFileBytes: 1,
      }),
    ).toThrow(/maxPromptFileBytes/);
  });

  it('rejects prompt files that are not valid UTF-8', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'bad.txt'), Buffer.from([0xc3, 0x28]));

    expect(() =>
      normalizeJobInput(baseJob({ kind: 'prompt', promptFile: 'bad.txt' }), { fileBaseDir: dir }),
    ).toThrow(/valid UTF-8/);
  });

  it('enforces prompt/promptFile XOR and sessionId/reuseSession XOR', () => {
    expect(() => normalizeJobInput(baseJob({ kind: 'prompt' }))).toThrow(/exactly one/);
    expect(() =>
      normalizeJobInput(baseJob({ kind: 'prompt', prompt: 'x', promptFile: 'prompt.txt' })),
    ).toThrow(/exactly one/);
    expect(() =>
      normalizeJobInput(baseJob({ kind: 'prompt', prompt: 'x', sessionId: 'sess-12345678', reuseSession: true })),
    ).toThrow(/VALIDATION_ERROR|Invalid job/);
  });

  it('rejects prompt/session fields on script and exec persisted schemas', () => {
    expect(JobSchema.safeParse(baseJob({ kind: 'script', script: 'echo hi', sessionId: 'sess-12345678' })).success).toBe(false);
    expect(JobSchema.safeParse(baseJob({ kind: 'exec', command: 'echo', engine: 'copilot' })).success).toBe(false);
    expect(JobSchema.safeParse(baseJob({ kind: 'prompt', prompt: 'x', script: 'echo hi' })).success).toBe(false);
  });

  it('validates prompt engine enum', () => {
    expect(JobSchema.safeParse(baseJob({ kind: 'prompt', prompt: 'x', engine: 'copilot' })).success).toBe(true);
    expect(JobSchema.safeParse(baseJob({ kind: 'prompt', prompt: 'x', engine: 'agency' })).success).toBe(true);
    expect(JobSchema.safeParse(baseJob({ kind: 'prompt', prompt: 'x', engine: 'openai' })).success).toBe(false);
  });
});
