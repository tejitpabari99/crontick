import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  normalizeJobInput,
  normalizeJobPatch,
  buildJobFromCreateOptions,
  buildJobPatchFromUpdateOptions,
  JobPatchInputSchema,
  type ActionInput,
  type JobCreateInput,
  type JobPatchCliOptions,
  type JobPatchInput,
} from '../src/job-input.js';
import { JobSchema, type Job } from '../src/schemas/job.js';

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

// ── buildJobFromCreateOptions — --exec verbatim + rawArgs (L6) ────────────────
// --exec takes the command verbatim (no whitespace splitting); everything
// after `--` (rawArgs) becomes action.args, reusing prompt mode's convention.

describe('buildJobFromCreateOptions — --exec verbatim + rawArgs (L6)', () => {
  it('takes the command verbatim and args from rawArgs, with no whitespace splitting', () => {
    const job = buildJobFromCreateOptions({
      id: 'exec-job', cron: '0 9 * * *', exec: 'node', rawArgs: ['-e', 'process.exit(0)'],
    });
    expect(job.action).toMatchObject({ kind: 'exec', command: 'node', args: ['-e', 'process.exit(0)'] });
  });

  it('preserves a single argument containing spaces intact (the naive-split bug this fixes)', () => {
    const job = buildJobFromCreateOptions({
      id: 'exec-job', cron: '0 9 * * *', exec: 'echo', rawArgs: ['hello world'],
    });
    expect(job.action).toMatchObject({ kind: 'exec', command: 'echo', args: ['hello world'] });
  });

  it('keeps a command string containing spaces intact when no rawArgs are given', () => {
    const job = buildJobFromCreateOptions({
      id: 'exec-job', cron: '0 9 * * *', exec: 'echo hello world',
    });
    expect(job.action).toMatchObject({ kind: 'exec', command: 'echo hello world', args: [] });
  });

  it('produces action output identical to the library/MCP args-array form for the same intent', () => {
    const viaExec = buildJobFromCreateOptions({
      id: 'exec-job', cron: '0 9 * * *', exec: 'node', rawArgs: ['-e', 'a b'],
    });
    const viaArgsArray = normalizeJobInput(baseJob({ kind: 'exec', command: 'node', args: ['-e', 'a b'] }));
    expect(viaExec.action).toEqual(viaArgsArray.action);
  });

  it('rejects rawArgs (--) on --script, unchanged from before L6', () => {
    expect(() =>
      buildJobFromCreateOptions({ id: 'exec-job', cron: '0 9 * * *', script: 'echo hi', rawArgs: ['extra'] }),
    ).toThrow(/Raw args after --/);
  });
});

// ── normalizeJobPatch / mergeActionPatch (Blockers 1 & 2) ──────────────────────

function patchOpts(overrides: Partial<JobPatchCliOptions>): JobPatchCliOptions {
  return { ...overrides };
}

function existingJob(action: unknown, overlap: Job['overlap'] = 'skip'): Job {
  const job = normalizeJobInput(baseJob(action));
  return { ...job, overlap };
}

describe('buildJobPatchFromUpdateOptions — overlap', () => {
  it('omits overlap from the patch when --overlap is not provided', () => {
    const patch = buildJobPatchFromUpdateOptions(patchOpts({ desc: 'x' }));
    expect(patch).not.toHaveProperty('overlap');
  });

  it('sets overlap to skip when explicitly provided (Commander no longer defaults it)', () => {
    const patch = buildJobPatchFromUpdateOptions(patchOpts({ overlap: 'skip' }));
    expect(patch.overlap).toBe('skip');
  });

  it('sets overlap to queue/cancel-previous when explicitly provided', () => {
    expect(buildJobPatchFromUpdateOptions(patchOpts({ overlap: 'queue' })).overlap).toBe('queue');
    expect(buildJobPatchFromUpdateOptions(patchOpts({ overlap: 'cancel-previous' })).overlap).toBe(
      'cancel-previous',
    );
  });
});

describe('normalizeJobPatch — overlap merge', () => {
  it('leaves overlap unchanged when the patch omits it', () => {
    const existing = existingJob({ kind: 'exec', command: 'echo' }, 'queue');
    const patch = buildJobPatchFromUpdateOptions(patchOpts({ desc: 'updated' }));
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.overlap).toBe('queue');
  });

  it('applies an explicit skip over a previously non-skip overlap', () => {
    const existing = existingJob({ kind: 'exec', command: 'echo' }, 'queue');
    const patch = buildJobPatchFromUpdateOptions(patchOpts({ overlap: 'skip' }));
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.overlap).toBe('skip');
  });
});

describe('normalizeJobPatch — action merge (mergeActionPatch)', () => {
  it('preserves shell/envFile/timeoutSec when only script is repeated', () => {
    const existing = existingJob({
      kind: 'script',
      script: 'echo hi',
      shell: 'cmd',
      envFile: '.env.test',
      timeoutSec: 30,
    });
    const patch = buildJobPatchFromUpdateOptions(patchOpts({ script: 'echo bye' }));
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.action).toMatchObject({
      kind: 'script',
      script: 'echo bye',
      shell: 'cmd',
      envFile: '.env.test',
      timeoutSec: 30,
    });
  });

  it('applies an explicit shell over the preserved action fields', () => {
    const existing = existingJob({ kind: 'script', script: 'echo hi', shell: 'cmd' });
    const patch = buildJobPatchFromUpdateOptions(patchOpts({ script: 'echo bye', shell: 'pwsh' }));
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.action).toMatchObject({ kind: 'script', script: 'echo bye', shell: 'pwsh' });
  });

  it('fully replaces the action when the kind changes (script -> exec)', () => {
    const existing = existingJob({
      kind: 'script',
      script: 'echo hi',
      shell: 'cmd',
      envFile: '.env.test',
      timeoutSec: 30,
    });
    const patch = buildJobPatchFromUpdateOptions(patchOpts({ exec: 'echo', rawArgs: ['done'] }));
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.action).toMatchObject({ kind: 'exec', command: 'echo', args: ['done'] });
    expect(result.action).not.toHaveProperty('shell');
    expect(result.action).not.toHaveProperty('script');
    // envFile/timeoutSec end up present-but-undefined (CLI always builds the
    // full action shape); JSON output omits undefined keys, so nothing leaks.
    expect((result.action as Record<string, unknown>).envFile).toBeUndefined();
    expect((result.action as Record<string, unknown>).timeoutSec).toBeUndefined();
  });

  it('leaves the action untouched entirely when the patch has no action fields', () => {
    const existing = existingJob({ kind: 'script', script: 'echo hi', shell: 'cmd' });
    const patch = buildJobPatchFromUpdateOptions(patchOpts({ desc: 'just a description change' }));
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.action).toEqual(existing.action);
  });
});

// ── normalizeJobPatch — exec/prompt args, reuseSession, retry, engine ──────────
// These patches are round-tripped through JobPatchInputSchema.parse (not built
// via buildJobPatchFromUpdateOptions) to faithfully simulate an MCP call or a
// CLI --file JSON patch: both validate the raw patch object against this exact
// schema before it ever reaches normalizeJobPatch. The CLI flag builder always
// supplies args/reuseSession/retry explicitly, so it can't reach the "field
// omitted" code path these tests cover — parsing a raw object through the
// schema is what actually exercises the patch-only optional() variants.

function mcpPatch(raw: unknown): JobPatchInput {
  const parsed = JobPatchInputSchema.safeParse(raw);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.format()));
  return parsed.data;
}

describe('normalizeJobPatch — exec args merge', () => {
  it('preserves exec args when the patch only changes envFile', () => {
    const existing = existingJob({ kind: 'exec', command: 'echo', args: ['a', 'b'] });
    const patch = mcpPatch({ action: { kind: 'exec', command: 'echo', envFile: '.env.new' } });
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.action).toMatchObject({ kind: 'exec', command: 'echo', args: ['a', 'b'], envFile: '.env.new' });
  });

  it('applies explicit exec args when provided', () => {
    const existing = existingJob({ kind: 'exec', command: 'echo', args: ['a', 'b'] });
    const patch = mcpPatch({ action: { kind: 'exec', command: 'echo', args: ['c'] } });
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.action).toMatchObject({ kind: 'exec', args: ['c'] });
  });
});

describe('normalizeJobPatch — prompt args/reuseSession merge', () => {
  it('preserves prompt args and reuseSession when the patch only changes prompt text', () => {
    const existing = existingJob({ kind: 'prompt', prompt: 'old', args: ['--flag'], reuseSession: true });
    const patch = mcpPatch({ action: { kind: 'prompt', prompt: 'new' } });
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.action).toMatchObject({ kind: 'prompt', prompt: 'new', args: ['--flag'], reuseSession: true });
  });

  it('applies explicit prompt args/reuseSession when provided', () => {
    const existing = existingJob({ kind: 'prompt', prompt: 'old', args: ['--flag'], reuseSession: true });
    const patch = mcpPatch({ action: { kind: 'prompt', prompt: 'old', args: [], reuseSession: false } });
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.action).toMatchObject({ args: [], reuseSession: false });
  });
});

describe('normalizeJobPatch — retry merge', () => {
  it('preserves retry.backoffSec when the patch only sets max', () => {
    const existing = { ...existingJob({ kind: 'exec', command: 'echo' }), retry: { max: 1, backoffSec: 90 } };
    const patch = mcpPatch({ retry: { max: 3 } });
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.retry).toEqual({ max: 3, backoffSec: 90 });
  });

  it('applies an explicit backoffSec over the preserved retry fields', () => {
    const existing = { ...existingJob({ kind: 'exec', command: 'echo' }), retry: { max: 1, backoffSec: 90 } };
    const patch = mcpPatch({ retry: { max: 3, backoffSec: 15 } });
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.retry).toEqual({ max: 3, backoffSec: 15 });
  });
});

describe('normalizeJobPatch — prompt engine preservation and kind-change defaulting', () => {
  it('preserves a custom engine on a same-kind prompt update that omits engine', () => {
    const existing = existingJob({ kind: 'prompt', prompt: 'old', engine: 'agency' });
    const patch = mcpPatch({ action: { kind: 'prompt', prompt: 'new' } });
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.action).toMatchObject({ kind: 'prompt', engine: 'agency' });
  });

  it('fills the configured default engine for a new prompt action introduced via a kind change', () => {
    const existing = existingJob({ kind: 'exec', command: 'echo' });
    const patch = mcpPatch({ action: { kind: 'prompt', prompt: 'hello' } });
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.action).toMatchObject({ kind: 'prompt', prompt: 'hello', engine: 'copilot' });
  });
});
