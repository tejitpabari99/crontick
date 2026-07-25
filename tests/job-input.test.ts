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

  it('enforces prompt/promptFile XOR and normalizes explicit session precedence', () => {
    expect(() => normalizeJobInput(baseJob({ kind: 'prompt' }))).toThrow(/exactly one/);
    expect(() =>
      normalizeJobInput(baseJob({ kind: 'prompt', prompt: 'x', promptFile: 'prompt.txt' })),
    ).toThrow(/exactly one/);
    const notices: string[] = [];
    const job = normalizeJobInput(
      baseJob({ kind: 'prompt', prompt: 'x', sessionId: 'sess-12345678', reuseSession: true }),
      { onNotice: (message) => notices.push(message) },
    );
    expect(job.action).toMatchObject({ kind: 'prompt', sessionId: 'sess-12345678', reuseSession: false });
    expect(notices.join('\n')).toContain('reuseSession was ignored');
  });

  it('rejects prompt/session fields on script and exec persisted schemas', () => {
    expect(JobSchema.safeParse(baseJob({ kind: 'script', script: 'echo hi', sessionId: 'sess-12345678' })).success).toBe(false);
    expect(JobSchema.safeParse(baseJob({ kind: 'exec', command: 'echo', engine: 'copilot' })).success).toBe(false);
    expect(JobSchema.safeParse(baseJob({ kind: 'prompt', prompt: 'x', script: 'echo hi' })).success).toBe(false);
  });

  it('validates prompt engine names', () => {
    expect(JobSchema.safeParse(baseJob({ kind: 'prompt', prompt: 'x', engine: 'copilot' })).success).toBe(true);
    expect(JobSchema.safeParse(baseJob({ kind: 'prompt', prompt: 'x', engine: 'agency' })).success).toBe(true);
    expect(JobSchema.safeParse(baseJob({ kind: 'prompt', prompt: 'x', engine: 'openai' })).success).toBe(true);
    expect(JobSchema.safeParse(baseJob({ kind: 'prompt', prompt: 'x', engine: 'bad engine' })).success).toBe(false);
  });

  it('rejects raw prompt passthrough args that collide with managed prompt/session flags', () => {
    for (const arg of ['-p', '--prompt', '--prompt=x', '--session-id', '--session-id=sess-12345678']) {
      expect(() => normalizeJobInput(baseJob({ kind: 'prompt', prompt: 'x', args: [arg] }))).toThrow(
        /prompt\/session flag/,
      );
    }
  });

  it('rejects prompt argv that exceeds the Windows-safe command line limit', () => {
    const prompt = 'x'.repeat(31_000);
    expect(() => normalizeJobInput(baseJob({ kind: 'prompt', prompt }))).toThrow(
      /Windows-safe command line limit/,
    );
  });
});
