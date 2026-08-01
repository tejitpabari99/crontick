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
} from '../../src/job-input.js';
import { CrontickError } from '../../src/errors.js';
import { readJsonFile } from '../../src/json-file.js';
import { JobSchema, type Job } from '../../src/schemas/job.js';

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

function expectJsonFileValidationError(fn: () => unknown, filePath: string, expectedShape: string): void {
  try {
    fn();
    throw new Error('Expected JSON file validation error');
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SyntaxError);
    const message = (err as Error).message;
    expect(message).toContain(filePath);
    expect(message).toMatch(/line \d+ column \d+ \(position \d+\)/);
    expect(message).toContain(expectedShape);
  }
}

function expectJsonFileEofValidationError(
  fn: () => unknown,
  filePath: string,
  expectedShape: string,
  expectedHint: string,
  expectedPosition: number,
): void {
  try {
    fn();
    throw new Error('Expected EOF JSON file validation error');
  } catch (err) {
    expect(err).toBeInstanceOf(CrontickError);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect(err).toMatchObject({
      details: expect.objectContaining({
        path: filePath,
        expectedShape,
        position: expectedPosition,
        line: expect.any(Number),
        column: expect.any(Number),
      }),
    });
    const message = (err as Error).message;
    expect(message).toContain(filePath);
    expect(message).toContain('Unexpected end of JSON input');
    expect(message).toMatch(/line \d+ column \d+ \(position \d+\)/);
    expect(message).toContain(expectedHint);
    expect(message).toContain(expectedShape);
  }
}

describe('readJsonFile', () => {
  it('accepts a BOM-prefixed JSON file', () => {
    const dir = makeDir();
    const filePath = join(dir, 'helper-bom.json');
    writeFileSync(filePath, `\uFEFF${JSON.stringify({ id: 'helper-bom-job' }, null, 2)}`, 'utf-8');

    expect(readJsonFile(filePath, {
      errorCode: 'VALIDATION_ERROR',
      subject: 'job definition file',
      expectedShape: 'expected a JSON object matching the crontick job schema',
    })).toMatchObject({ id: 'helper-bom-job' });
  });

  it('reports malformed JSON with caller-specific expected shapes', () => {
    const dir = makeDir();
    const cases = [
      {
        fileName: 'bad-job.json',
        options: {
          errorCode: 'VALIDATION_ERROR',
          subject: 'job definition file',
          expectedShape: 'expected a JSON object matching the crontick job schema',
        },
      },
      {
        fileName: 'bad-import.json',
        options: {
          errorCode: 'VALIDATION_ERROR',
          subject: 'import file',
          expectedShape: 'expected either a JSON array of jobs or an export object with jobs and optional runs',
        },
      },
      {
        fileName: 'bad-config.json',
        options: {
          errorCode: 'CONFIG_READ_ERROR',
          subject: 'config file',
          expectedShape: 'expected a JSON object matching the crontick config schema',
        },
      },
    ] as const;

    for (const testCase of cases) {
      const filePath = join(dir, testCase.fileName);
      writeFileSync(filePath, '{ nope', 'utf-8');

      try {
        readJsonFile(filePath, testCase.options);
        throw new Error(`Expected readJsonFile to fail for ${testCase.fileName}`);
      } catch (err) {
        expect(err).toBeInstanceOf(CrontickError);
        expect(err).toMatchObject({
          code: testCase.options.errorCode,
          details: expect.objectContaining({
            path: filePath,
            expectedShape: testCase.options.expectedShape,
            position: expect.any(Number),
            line: expect.any(Number),
            column: expect.any(Number),
          }),
        });
        const message = (err as Error).message;
        expect(message).toContain(filePath);
        expect(message).toMatch(/line \d+ column \d+ \(position \d+\)/);
        expect(message).toContain(testCase.options.expectedShape);
      }
    }
  });

  it('reports EOF-truncated JSON with end-of-input positions and unfinished-construct hints', () => {
    const dir = makeDir();
    const cases = [
      {
        fileName: 'eof-job.json',
        contents: '{ "id": "helper-eof-job", "schedule": ',
        options: {
          errorCode: 'VALIDATION_ERROR',
          subject: 'job definition file',
          expectedShape: 'expected a JSON object matching the crontick job schema',
        },
        expectedHint: "expected a value after ':'",
      },
      {
        fileName: 'eof-import.json',
        contents: '{ "jobs": [ ',
        options: {
          errorCode: 'VALIDATION_ERROR',
          subject: 'import file',
          expectedShape: 'expected either a JSON array of jobs or an export object with jobs and optional runs',
        },
        expectedHint: 'unterminated array',
      },
      {
        fileName: 'eof-config.json',
        contents: '{ "defaultEngine": ',
        options: {
          errorCode: 'CONFIG_READ_ERROR',
          subject: 'config file',
          expectedShape: 'expected a JSON object matching the crontick config schema',
        },
        expectedHint: "expected a value after ':'",
      },
    ] as const;

    for (const testCase of cases) {
      const filePath = join(dir, testCase.fileName);
      writeFileSync(filePath, testCase.contents, 'utf-8');
      expectJsonFileEofValidationError(
        () => readJsonFile(filePath, testCase.options),
        filePath,
        testCase.options.expectedShape,
        testCase.expectedHint,
        testCase.contents.length,
      );
    }
  });
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

describe('buildJobFromCreateOptions/buildJobPatchFromUpdateOptions — JSON file input', () => {
  it('accepts a BOM-prefixed job definition file', () => {
    const dir = makeDir();
    const filePath = join(dir, 'job.json');
    writeFileSync(filePath, `\uFEFF${JSON.stringify(baseJob({ kind: 'exec', command: 'echo', args: ['bom'] }), null, 2)}`, 'utf-8');

    const job = buildJobFromCreateOptions({ id: 'ignored-by-file', file: 'job.json' }, { cwd: dir });
    expect(job).toMatchObject({
      id: 'prompt-job',
      action: { kind: 'exec', command: 'echo', args: ['bom'] },
    });
  });

  it('accepts a BOM-prefixed job patch file', () => {
    const dir = makeDir();
    const filePath = join(dir, 'patch.json');
    writeFileSync(filePath, `\uFEFF${JSON.stringify({ action: { kind: 'exec', command: 'echo', args: ['patched'] } }, null, 2)}`, 'utf-8');

    const patch = buildJobPatchFromUpdateOptions({ file: 'patch.json' }, { cwd: dir });
    expect(patch).toMatchObject({ action: { kind: 'exec', command: 'echo', args: ['patched'] } });
  });

  it('reports malformed job definition JSON with file path, parse position, and expected shape', () => {
    const dir = makeDir();
    const filePath = join(dir, 'bad-job.json');
    writeFileSync(filePath, '{ nope', 'utf-8');

    expectJsonFileValidationError(
      () => buildJobFromCreateOptions({ id: 'ignored-by-file', file: 'bad-job.json' }, { cwd: dir }),
      filePath,
      'expected a JSON object matching the crontick job schema',
    );
  });

  it('reports malformed job patch JSON with file path, parse position, and expected shape', () => {
    const dir = makeDir();
    const filePath = join(dir, 'bad-patch.json');
    writeFileSync(filePath, '{ nope', 'utf-8');

    expectJsonFileValidationError(
      () => buildJobPatchFromUpdateOptions({ file: 'bad-patch.json' }, { cwd: dir }),
      filePath,
      'expected a JSON object matching the crontick job patch schema',
    );
  });
});

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
    ).toThrow(/valid only with --exec/);
  });
});

// ── buildJobFromCreateOptions — explicit --arg (Blocker 1) ─────────────────────
// --arg <value> is the new, always-correct, shim-independent way to pass args
// to --exec/--prompt actions: it never depends on `--` surviving a Windows
// shim (crontick.cmd/.ps1), so it round-trips spaces, embedded double quotes,
// and leading dashes byte-for-byte, unlike the shim-mangled `--` convention.

describe('buildJobFromCreateOptions — explicit --arg (Blocker 1)', () => {
  it('builds exec args from --arg, equivalent to the -- convention for the same values', () => {
    const viaArg = buildJobFromCreateOptions({
      id: 'exec-job', cron: '0 9 * * *', exec: 'node', args: ['-e', 'process.exit(0)'],
    });
    const viaDashDash = buildJobFromCreateOptions({
      id: 'exec-job', cron: '0 9 * * *', exec: 'node', rawArgs: ['-e', 'process.exit(0)'],
    });
    expect(viaArg.action).toEqual(viaDashDash.action);
  });

  it('round-trips a single --arg value containing spaces, embedded double quotes, and a leading dash', () => {
    const tricky = '-flag with spaces and "embedded quotes"';
    const job = buildJobFromCreateOptions({
      id: 'exec-job', cron: '0 9 * * *', exec: 'echo', args: [tricky],
    });
    expect(job.action).toMatchObject({ kind: 'exec', command: 'echo', args: [tricky] });
  });

  it('supports repeatable --arg for multiple values', () => {
    const job = buildJobFromCreateOptions({
      id: 'exec-job', cron: '0 9 * * *', exec: 'node', args: ['-e', 'a b', '--weird-flag'],
    });
    expect(job.action).toMatchObject({ kind: 'exec', args: ['-e', 'a b', '--weird-flag'] });
  });

  it('works identically for --prompt actions', () => {
    const tricky = '-flag with spaces and "embedded quotes"';
    const job = buildJobFromCreateOptions({
      id: 'prompt-job', cron: '0 9 * * *', prompt: 'hi', args: [tricky],
    });
    expect(job.action).toMatchObject({ kind: 'prompt', args: [tricky] });
  });

  it('rejects combining --arg with -- positional args in the same command (ambiguous)', () => {
    expect(() =>
      buildJobFromCreateOptions({
        id: 'exec-job', cron: '0 9 * * *', exec: 'node', args: ['-e'], rawArgs: ['x'],
      }),
    ).toThrow(/Cannot combine --arg/);
  });

  it('rejects --arg on --script, same as -- positional args', () => {
    expect(() =>
      buildJobFromCreateOptions({ id: 'exec-job', cron: '0 9 * * *', script: 'echo hi', args: ['extra'] }),
    ).toThrow(/valid only with --exec/);
  });
});

// ── normalizeJobPatch / mergeActionPatch (Blockers 1 & 2) ──────────────────────

function patchOpts(overrides: Partial<JobPatchCliOptions>): JobPatchCliOptions {
  return { ...overrides };
}

describe('buildJobPatchFromUpdateOptions - no update flag silently no-ops', () => {
  it('makes every update flag either apply or fail loudly when passed alone', () => {
    const dir = makeDir();
    const promptFile = join(dir, 'prompt.txt');
    const patchFile = join(dir, 'patch.json');
    writeFileSync(promptFile, 'from file', 'utf-8');
    writeFileSync(patchFile, JSON.stringify({ description: 'from file patch' }), 'utf-8');

    const cases: Array<{
      flag: string;
      opts: JobPatchCliOptions;
      options?: { cwd?: string };
      assert?: (patch: JobPatchInput) => void;
      error?: RegExp;
    }> = [
      { flag: '--cron', opts: patchOpts({ cron: '0 9 * * *' }), assert: (patch) => expect(patch.schedule).toEqual({ kind: 'cron', cron: '0 9 * * *' }) },
      { flag: '--every', opts: patchOpts({ every: 60 }), assert: (patch) => expect(patch.schedule).toEqual({ kind: 'interval', everySec: 60 }) },
      { flag: '--at', opts: patchOpts({ at: '2030-01-01T00:00:00.000Z' }), assert: (patch) => expect(patch.schedule).toEqual({ kind: 'one-shot', runAt: '2030-01-01T00:00:00.000Z' }) },
      { flag: '--tz', opts: patchOpts({ tz: 'UTC' }), error: /--tz requires --cron on update/ },
      { flag: '--script', opts: patchOpts({ script: 'echo hi' }), assert: (patch) => expect(patch.action).toMatchObject({ kind: 'script', script: 'echo hi' }) },
      { flag: '--exec', opts: patchOpts({ exec: 'echo' }), assert: (patch) => expect(patch.action).toMatchObject({ kind: 'exec', command: 'echo', args: [] }) },
      { flag: '--prompt', opts: patchOpts({ prompt: 'hello' }), assert: (patch) => expect(patch.action).toMatchObject({ kind: 'prompt', prompt: 'hello' }) },
      { flag: '--prompt-file', opts: patchOpts({ promptFile }), assert: (patch) => expect(patch.action).toMatchObject({ kind: 'prompt', prompt: 'from file' }) },
      { flag: '--arg', opts: patchOpts({ args: ['x'] }), error: /Arguments \(via --arg or --\) are valid only/ },
      { flag: '--', opts: patchOpts({ rawArgs: ['x'] }), error: /Arguments \(via --arg or --\) are valid only/ },
      { flag: '--engine', opts: patchOpts({ engine: 'copilot' }), error: /Prompt engine\/session flags are valid only with prompt mode/ },
      { flag: '--session-id', opts: patchOpts({ sessionId: 'sess-12345678' }), error: /Prompt engine\/session flags are valid only with prompt mode/ },
      { flag: '--reuse-session', opts: patchOpts({ reuseSession: true }), error: /Prompt engine\/session flags are valid only with prompt mode/ },
      { flag: '--file', opts: patchOpts({ file: 'patch.json' }), options: { cwd: dir }, assert: (patch) => expect(patch.description).toBe('from file patch') },
      { flag: '--shell', opts: patchOpts({ shell: 'pwsh' }), error: /--shell requires an action source on update/ },
      { flag: '--job-env-file', opts: patchOpts({ envFile: join(dir, 'vars.env') }), error: /--job-env-file .* requires an action source on update/ },
      { flag: '--timeout', opts: patchOpts({ timeout: 30 }), error: /--timeout requires an action source on update/ },
      { flag: '--overlap', opts: patchOpts({ overlap: 'queue' }), assert: (patch) => expect(patch.overlap).toBe('queue') },
      { flag: '--retry', opts: patchOpts({ retry: 3 }), assert: (patch) => expect(patch.retry).toEqual({ max: 3, backoffSec: 30 }) },
      { flag: '--desc', opts: patchOpts({ desc: 'updated' }), assert: (patch) => expect(patch.description).toBe('updated') },
      { flag: '--enable', opts: patchOpts({ enabled: true }), assert: (patch) => expect(patch.enabled).toBe(true) },
      { flag: '--disable', opts: patchOpts({ enabled: false }), assert: (patch) => expect(patch.enabled).toBe(false) },
    ];

    for (const testCase of cases) {
      if (testCase.error) {
        expect(() => buildJobPatchFromUpdateOptions(testCase.opts, testCase.options)).toThrow(testCase.error);
        continue;
      }
      const patch = buildJobPatchFromUpdateOptions(testCase.opts, testCase.options);
      expect(patch).not.toEqual({});
      testCase.assert?.(patch);
    }
  });

  it('rejects --tz on non-cron update schedules instead of silently dropping it', () => {
    expect(() => buildJobPatchFromUpdateOptions(patchOpts({ every: 60, tz: 'UTC' }))).toThrow(/--tz requires --cron on update/);
    expect(() => buildJobPatchFromUpdateOptions(patchOpts({ at: '2030-01-01T00:00:00.000Z', tz: 'UTC' }))).toThrow(/--tz requires --cron on update/);
  });
});

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

