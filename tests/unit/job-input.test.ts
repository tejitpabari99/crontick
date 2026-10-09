import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  normalizeJobInput,
  normalizeJobPatch,
  buildJobFromCreateOptions,
  buildJobPatchFromUpdateOptions,
  generateAlias,
  JobCreateInputSchema,
  JobPatchInputSchema,
  type ActionInput,
  type JobCreateInput,
  type JobPatchCliOptions,
  type JobPatchInput,
} from '../../src/job-input.js';
import { CrontickError } from '../../src/errors.js';
import { readJsonFile } from '../../src/json-file.js';
import { JobSchema, type Job } from '../../src/schemas/job.js';

function configOptions(dir: string) {
  return { cwd: dir, env: { ...process.env, CRONTICK_HOME: dir } };
}

function writeDefaults(dir: string, defaults: unknown): void {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ defaults }));
}

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
    alias: 'prompt-job',
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
  it('snapshots config defaults for missing job fields, including partial retry input', () => {
    const dir = makeDir();
    writeDefaults(dir, { overlap: 'queue', timeoutSec: 120, retry: { max: 3, backoffSec: 45 } });
    const options = configOptions(dir);
    const first = normalizeJobInput(baseJob({ kind: 'prompt', prompt: 'Summarize' }), options);
    expect(first).toMatchObject({ overlap: 'queue', retry: { max: 3, backoffSec: 45 }, action: { timeoutSec: 120 } });

    const partial = normalizeJobInput({ ...baseJob({ kind: 'prompt', prompt: 'Summarize' }), retry: { max: 5 } }, options);
    expect(partial.retry).toEqual({ max: 5, backoffSec: 45 });

    writeDefaults(dir, { overlap: 'cancel-previous', timeoutSec: 10, retry: { max: 1, backoffSec: 5 } });
    expect(first).toMatchObject({ overlap: 'queue', retry: { max: 3, backoffSec: 45 }, action: { timeoutSec: 120 } });
    const updated = normalizeJobPatch(first.id, first, { description: 'edited' }, options);
    expect(updated).toMatchObject({ overlap: 'queue', retry: { max: 3, backoffSec: 45 }, action: { timeoutSec: 120 } });
    expect(normalizeJobInput(baseJob({ kind: 'prompt', prompt: 'New' }), options)).toMatchObject({
      overlap: 'cancel-previous', retry: { max: 1, backoffSec: 5 }, action: { timeoutSec: 10 },
    });
  });

  it('lets explicit JSON and CLI values override config defaults', () => {
    const dir = makeDir();
    writeDefaults(dir, { overlap: 'queue', timeoutSec: 120, retry: { max: 3, backoffSec: 45 } });
    const options = configOptions(dir);
    const json = normalizeJobInput({
      ...baseJob({ kind: 'prompt', prompt: 'Summarize', timeoutSec: 25 }),
      overlap: 'skip', retry: { max: 7, backoffSec: 8 },
    }, options);
    expect(json).toMatchObject({ overlap: 'skip', retry: { max: 7, backoffSec: 8 }, action: { timeoutSec: 25 } });

    const cli = buildJobFromCreateOptions({ cron: '0 9 * * *', prompt: 'Summarize', overlap: 'skip', timeout: 20, retry: 4 }, options);
    expect(cli).toMatchObject({ overlap: 'skip', retry: { max: 4, backoffSec: 45 }, action: { timeoutSec: 20 } });
    const cliUnspecified = buildJobFromCreateOptions({ cron: '0 9 * * *', prompt: 'Summarize' }, options);
    expect(cliUnspecified).toMatchObject({ overlap: 'queue', retry: { max: 3, backoffSec: 45 }, action: { timeoutSec: 120 } });
  });

  it('keeps omitted MCP create fields absent until config resolution', () => {
    const dir = makeDir();
    writeDefaults(dir, { overlap: 'queue', timeoutSec: 90, retry: { max: 2, backoffSec: 15 } });
    const parsed = JobCreateInputSchema.parse(baseJob({ kind: 'prompt', prompt: 'MCP' }));
    expect(parsed).not.toHaveProperty('overlap');
    expect(parsed).not.toHaveProperty('retry');
    expect(normalizeJobInput(parsed, configOptions(dir))).toMatchObject({
      overlap: 'queue', retry: { max: 2, backoffSec: 15 }, action: { timeoutSec: 90 },
    });
  });

  it('normalizes prompt text jobs with defaults', () => {
    const job = normalizeJobInput(baseJob({ kind: 'prompt', prompt: 'Summarize' }));
    expect(job.action).toEqual({
      kind: 'prompt',
      prompt: 'Summarize',
      engine: 'claude',
      args: [],
      reuseSession: false,
      cwd: process.cwd(),
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
    expect(notices).toEqual([]);
  });

  it('rejects the removed script and exec action kinds (crontick is prompt-only)', () => {
    expect(JobSchema.safeParse(baseJob({ kind: 'script', script: 'echo hi' })).success).toBe(false);
    expect(JobSchema.safeParse(baseJob({ kind: 'exec', command: 'echo' })).success).toBe(false);
    // Unknown fields on the (only remaining) prompt kind are still rejected by .strict().
    expect(JobSchema.safeParse(baseJob({ kind: 'prompt', prompt: 'x', script: 'echo hi' })).success).toBe(false);
    expect(JobSchema.safeParse(baseJob({ kind: 'prompt', prompt: 'x', command: 'echo' })).success).toBe(false);
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

describe('buildJobFromCreateOptions/buildJobPatchFromUpdateOptions — JSON file input', () => {
  it('accepts a BOM-prefixed job definition file', () => {
    const dir = makeDir();
    const filePath = join(dir, 'job.json');
    writeFileSync(filePath, `\uFEFF${JSON.stringify(baseJob({ kind: 'prompt', prompt: 'bom', args: ['x'] }), null, 2)}`, 'utf-8');

    const job = buildJobFromCreateOptions({ file: 'job.json' }, { cwd: dir });
    expect(job).toMatchObject({
      alias: 'prompt-job',
      action: { kind: 'prompt', prompt: 'bom', args: ['x'] },
    });
  });

  it('accepts a BOM-prefixed job patch file', () => {
    const dir = makeDir();
    const filePath = join(dir, 'patch.json');
    writeFileSync(filePath, `\uFEFF${JSON.stringify({ action: { kind: 'prompt', prompt: 'patched' } }, null, 2)}`, 'utf-8');

    const patch = buildJobPatchFromUpdateOptions({ file: 'patch.json' }, { cwd: dir });
    expect(patch).toMatchObject({ action: { kind: 'prompt', prompt: 'patched' } });
  });

  it('reports malformed job definition JSON with file path, parse position, and expected shape', () => {
    const dir = makeDir();
    const filePath = join(dir, 'bad-job.json');
    writeFileSync(filePath, '{ nope', 'utf-8');

    expectJsonFileValidationError(
      () => buildJobFromCreateOptions({ file: 'bad-job.json' }, { cwd: dir }),
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

// ── buildJobFromCreateOptions — explicit --arg (Blocker 1) ─────────────────────
// --arg <value> is the always-correct, shim-independent way to pass args to a
// --prompt action: it never depends on `--` surviving a Windows shim
// (crontick.cmd/.ps1), so it round-trips spaces, embedded double quotes, and
// leading dashes byte-for-byte, unlike the shim-mangled `--` convention.

describe('buildJobFromCreateOptions — explicit --arg (Blocker 1)', () => {
  it('builds prompt args from --arg, equivalent to the -- convention for the same values', () => {
    const viaArg = buildJobFromCreateOptions({
      cron: '0 9 * * *', prompt: 'hi', args: ['-e', 'a b'],
    });
    const viaDashDash = buildJobFromCreateOptions({
      cron: '0 9 * * *', prompt: 'hi', rawArgs: ['-e', 'a b'],
    });
    expect(viaArg.action).toEqual(viaDashDash.action);
  });

  it('round-trips a single --arg value containing spaces, embedded double quotes, and a leading dash', () => {
    const tricky = '-flag with spaces and "embedded quotes"';
    const job = buildJobFromCreateOptions({
      cron: '0 9 * * *', prompt: 'hi', args: [tricky],
    });
    expect(job.action).toMatchObject({ kind: 'prompt', prompt: 'hi', args: [tricky] });
  });

  it('supports repeatable --arg for multiple values', () => {
    const job = buildJobFromCreateOptions({
      cron: '0 9 * * *', prompt: 'hi', args: ['-e', 'a b', '--weird-flag'],
    });
    expect(job.action).toMatchObject({ kind: 'prompt', args: ['-e', 'a b', '--weird-flag'] });
  });

  it('rejects combining --arg with -- positional args in the same command (ambiguous)', () => {
    expect(() =>
      buildJobFromCreateOptions({
        cron: '0 9 * * *', prompt: 'hi', args: ['-e'], rawArgs: ['x'],
      }),
    ).toThrow(/Cannot combine --arg/);
  });

  it('merges unknown flag passthrough with either argument source without relaxing their exclusion', () => {
    const base = { cron: '0 9 * * *', prompt: 'hi', passthroughArgs: ['--allow-all', '--permission-mode', 'acceptEdits'] };
    expect(buildJobFromCreateOptions({ ...base, rawArgs: ['literal'] }).action)
      .toMatchObject({ args: ['literal', '--allow-all', '--permission-mode', 'acceptEdits'] });
    expect(buildJobFromCreateOptions({ ...base, args: ['literal'] }).action)
      .toMatchObject({ args: ['literal', '--allow-all', '--permission-mode', 'acceptEdits'] });
    expect(buildJobFromCreateOptions({ ...base, rawArgs: ['literal'], cliArgvOrder: ['--allow-all', 'literal', '--permission-mode', 'acceptEdits'] }).action)
      .toMatchObject({ args: ['--allow-all', 'literal', '--permission-mode', 'acceptEdits'] });
    expect(() => buildJobFromCreateOptions({ ...base, args: ['one'], rawArgs: ['two'] }))
      .toThrow(/Cannot combine --arg/);
  });

  it.each(['--output-format', '--output-format=json', '--settings', '--settings={}', '--session-id=mine'])(
    'rejects reserved passthrough argument %s', (arg) => {
      expect(() => buildJobFromCreateOptions({ cron: '0 9 * * *', prompt: 'hi', passthroughArgs: [arg] }))
        .toThrow(/Raw prompt engine args cannot include crontick-managed prompt\/session flag/);
      expect(() => buildJobPatchFromUpdateOptions({ prompt: 'hi', passthroughArgs: [arg] }))
        .toThrow(/Raw prompt engine args cannot include crontick-managed prompt\/session flag/);
    },
  );
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
      { flag: '--prompt', opts: patchOpts({ prompt: 'hello' }), assert: (patch) => expect(patch.action).toMatchObject({ kind: 'prompt', prompt: 'hello' }) },
      { flag: '--prompt-file', opts: patchOpts({ promptFile }), assert: (patch) => expect(patch.action).toMatchObject({ kind: 'prompt', prompt: 'from file' }) },
      { flag: '--arg', opts: patchOpts({ args: ['x'] }), error: /Arguments \(via --arg or --\) are valid only/ },
      { flag: '--', opts: patchOpts({ rawArgs: ['x'] }), error: /Arguments \(via --arg or --\) are valid only/ },
      { flag: '--engine', opts: patchOpts({ engine: 'copilot' }), error: /Prompt engine\/session flags are valid only with prompt mode/ },
      { flag: '--session-id', opts: patchOpts({ sessionId: 'sess-12345678' }), error: /Prompt engine\/session flags are valid only with prompt mode/ },
      { flag: '--reuse-session', opts: patchOpts({ reuseSession: true }), error: /Prompt engine\/session flags are valid only with prompt mode/ },
      { flag: '--file', opts: patchOpts({ file: 'patch.json' }), options: { cwd: dir }, assert: (patch) => expect(patch.description).toBe('from file patch') },
      { flag: '--job-env-file', opts: patchOpts({ envFile: join(dir, 'vars.env') }), error: /--job-env-file .* requires an action source on update/ },
      { flag: '--timeout', opts: patchOpts({ timeout: 30 }), error: /--timeout requires an action source on update/ },
      { flag: '--overlap', opts: patchOpts({ overlap: 'queue' }), assert: (patch) => expect(patch.overlap).toBe('queue') },
      { flag: '--retry', opts: patchOpts({ retry: 3 }), assert: (patch) => expect(patch.retry).toEqual({ max: 3 }) },
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

  it('rejects the removed schedule.tz on create and patch input', () => {
    const withTz = { kind: 'cron', cron: '0 9 * * *', tz: 'UTC' } as unknown as JobCreateInput['schedule'];
    expect(() => normalizeJobInput({ schedule: withTz, action: { kind: 'prompt', prompt: 'x' } })).toThrow(/schedule\.tz is not supported/);
    expect(() => normalizeJobPatch('job-1', existingJob({ kind: 'prompt', prompt: 'x', args: [] }), { schedule: withTz })).toThrow(/schedule\.tz is not supported/);
  });

  it('resolves --enable/--disable flags in core and rejects passing both together', () => {
    expect(buildJobPatchFromUpdateOptions(patchOpts({ enable: true })).enabled).toBe(true);
    expect(buildJobPatchFromUpdateOptions(patchOpts({ disable: true })).enabled).toBe(false);
    expect(() => buildJobPatchFromUpdateOptions(patchOpts({ enable: true, disable: true }))).toThrow(
      /--enable and --disable are mutually exclusive/,
    );
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
    const existing = existingJob({ kind: 'prompt', prompt: 'hello' }, 'queue');
    const patch = buildJobPatchFromUpdateOptions(patchOpts({ desc: 'updated' }));
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.overlap).toBe('queue');
  });

  it('applies an explicit skip over a previously non-skip overlap', () => {
    const existing = existingJob({ kind: 'prompt', prompt: 'hello' }, 'queue');
    const patch = buildJobPatchFromUpdateOptions(patchOpts({ overlap: 'skip' }));
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.overlap).toBe('skip');
  });
});

describe('normalizeJobPatch — action merge (mergeActionPatch)', () => {
  it('preserves envFile/timeoutSec when only prompt text is repeated', () => {
    const existing = existingJob({
      kind: 'prompt',
      prompt: 'hello',
      envFile: '.env.test',
      timeoutSec: 30,
    });
    const patch = buildJobPatchFromUpdateOptions(patchOpts({ prompt: 'goodbye' }));
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.action).toMatchObject({
      kind: 'prompt',
      prompt: 'goodbye',
      envFile: '.env.test',
      timeoutSec: 30,
    });
  });

  it('applies an explicit engine override over the preserved action fields', () => {
    const existing = existingJob({ kind: 'prompt', prompt: 'hello', engine: 'agency' });
    const patch = buildJobPatchFromUpdateOptions(patchOpts({ prompt: 'goodbye', engine: 'openai' }));
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.action).toMatchObject({ kind: 'prompt', prompt: 'goodbye', engine: 'openai' });
  });

  it('leaves the action untouched entirely when the patch has no action fields', () => {
    const existing = existingJob({ kind: 'prompt', prompt: 'hello', engine: 'agency' });
    const patch = buildJobPatchFromUpdateOptions(patchOpts({ desc: 'just a description change' }));
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.action).toEqual(existing.action);
  });

  it('estimates an args-only patch\'s command line using the claude fallback engine name, not the removed copilot default', () => {
    // An args-only patch (no prompt/engine in the patch itself) is runtime-validated
    // before being merged onto the existing action (see normalizeActionInput's
    // args-only branch in src/job-input.ts), using placeholder prompt/engine values
    // since the final resolved ones aren't known yet. That placeholder engine must
    // be 'claude' (6 chars) -- the only remaining engine -- not the removed
    // 'copilot' default (7 chars). With a 30,000-char arg, the estimate is
    // 6 (engine) + 1 + 0 (placeholder prompt) + 1 + 30,000 = 30,008 for 'claude'
    // vs 30,009 for 'copilot'; asserting the exact embedded number pins down
    // which fallback produced it.
    const existing = existingJob({ kind: 'prompt', prompt: 'hello', engine: 'claude' });
    const patch: JobPatchInput = { action: { kind: 'prompt', args: ['a'.repeat(30_000)] } as ActionInput };
    expect(() => normalizeJobPatch('job-1', existing, patch)).toThrow(/\(30008\/32767 characters\)/);
  });
});

// ── normalizeJobPatch — prompt args/reuseSession/retry/engine ──────────────────
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

  it('preserves prompt args when the patch only changes envFile', () => {
    const existing = existingJob({ kind: 'prompt', prompt: 'old', args: ['a', 'b'] });
    const patch = mcpPatch({ action: { kind: 'prompt', prompt: 'old', envFile: '.env.new' } });
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.action).toMatchObject({ kind: 'prompt', args: ['a', 'b'], envFile: '.env.new' });
  });
});

describe('normalizeJobPatch — retry merge', () => {
  it('preserves stored backoff when the CLI only changes retry max', () => {
    const existing = { ...existingJob({ kind: 'prompt', prompt: 'hello' }), retry: { max: 1, backoffSec: 90 } };
    const patch = buildJobPatchFromUpdateOptions({ retry: 3 });
    expect(normalizeJobPatch(existing.id, existing, patch).retry).toEqual({ max: 3, backoffSec: 90 });
  });

  it('preserves retry.backoffSec when the patch only sets max', () => {
    const existing = { ...existingJob({ kind: 'prompt', prompt: 'hello' }), retry: { max: 1, backoffSec: 90 } };
    const patch = mcpPatch({ retry: { max: 3 } });
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.retry).toEqual({ max: 3, backoffSec: 90 });
  });

  it('applies an explicit backoffSec over the preserved retry fields', () => {
    const existing = { ...existingJob({ kind: 'prompt', prompt: 'hello' }), retry: { max: 1, backoffSec: 90 } };
    const patch = mcpPatch({ retry: { max: 3, backoffSec: 15 } });
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.retry).toEqual({ max: 3, backoffSec: 15 });
  });
});

describe('normalizeJobPatch — prompt engine preservation', () => {
  it('preserves a custom engine on a same-kind prompt update that omits engine', () => {
    const existing = existingJob({ kind: 'prompt', prompt: 'old', engine: 'agency' });
    const patch = mcpPatch({ action: { kind: 'prompt', prompt: 'new' } });
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.action).toMatchObject({ kind: 'prompt', engine: 'agency' });
  });
});

// ── CTD-026 regression: single-field action patches (no prompt re-supplied) ───

describe('normalizeJobPatch — single-field action patch (CTD-026)', () => {
  it('accepts a prompt patch with only timeoutSec (no prompt re-supplied) and merges it', () => {
    const existing = existingJob({ kind: 'prompt', prompt: 'hello world', reuseSession: true });
    const patch = mcpPatch({ action: { kind: 'prompt', timeoutSec: 45 } });
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.action).toMatchObject({ kind: 'prompt', prompt: 'hello world', reuseSession: true, timeoutSec: 45 });
  });

  it('accepts a prompt patch with only envFile (no prompt re-supplied) and merges it', () => {
    const existing = existingJob({ kind: 'prompt', prompt: 'hello world' });
    const patch = mcpPatch({ action: { kind: 'prompt', envFile: '.env.ai' } });
    const result = normalizeJobPatch('job-1', existing, patch);
    expect(result.action).toMatchObject({ kind: 'prompt', prompt: 'hello world', envFile: '.env.ai' });
  });
});

// ── normalizeJobPatch — B-2 sessionId+reuseSession invariant ─────────────────
describe('normalizeJobPatch — sessionId-only prompt patch clears reuseSession (B-2 regression)', () => {
  it('clears reuseSession when a sessionId-only patch is applied to a job with reuseSession=true', () => {
    const notices: string[] = [];
    const existing = existingJob({ kind: 'prompt', prompt: 'do the thing', args: [], reuseSession: true });
    // Patch carries only sessionId, no prompt/promptFile — exercises the early-return path
    const patch = mcpPatch({ action: { kind: 'prompt', sessionId: 'sess-12345678' } });
    const result = normalizeJobPatch('job-1', existing, patch, { onNotice: (m) => notices.push(m) });
    expect((result.action as Record<string, unknown>).reuseSession, 'reuseSession must be cleared').toBe(false);
    expect((result.action as Record<string, unknown>).sessionId).toBe('sess-12345678');
    expect(notices).toEqual([]);
  });

  it('leaves reuseSession unchanged when sessionId is not in the patch', () => {
    const existing = existingJob({ kind: 'prompt', prompt: 'do the thing', reuseSession: true });
    const patch = mcpPatch({ action: { kind: 'prompt', timeoutSec: 30 } });
    const result = normalizeJobPatch('job-1', existing, patch);
    expect((result.action as Record<string, unknown>).reuseSession).toBe(true);
  });
});

// ── normalizeJobPatch — C-1 args-only prompt patch validation ─────────────────
// Decision: route args-only patches through validatePromptActionRuntimeArgs so
// reserved-arg errors surface at patch time.
describe('normalizeJobPatch — args-only prompt patch validation (C-1)', () => {
  it('accepts a valid args-only prompt patch', () => {
    const existing = existingJob({ kind: 'prompt', prompt: 'hello', args: [] });
    const patch = mcpPatch({ action: { kind: 'prompt', args: ['--verbose'] } });
    const result = normalizeJobPatch('job-1', existing, patch);
    expect((result.action as Record<string, unknown>).args).toEqual(['--verbose']);
  });

  it('rejects reserved args in an args-only prompt patch at patch time', () => {
    const existing = existingJob({ kind: 'prompt', prompt: 'hello', args: [] });
    // --session-id is a reserved crontick arg that the runtime would reject
    const patch = mcpPatch({ action: { kind: 'prompt', args: ['--session-id', 'x'] } });
    expect(() => normalizeJobPatch('job-1', existing, patch)).toThrow();
  });
});

// ── generateAlias — auto-generated unique alias ──────────────────────────────
describe('generateAlias', () => {
  it('generates a <word>-<1-1000> alias using the injected word list and RNG', () => {
    // random() is called twice per attempt: first to pick the word index,
    // then for the 1-1000 suffix. A constant 0 RNG picks words[0] and suffix 1.
    const alias = generateAlias(() => false, { words: ['atlas', 'birch'], random: () => 0 });
    expect(alias).toBe('atlas-1');
  });

  it('retries on collision until an untaken candidate is produced', () => {
    let calls = 0;
    // isTaken reports the first two candidates as taken, the third as free.
    const isTaken = (): boolean => {
      calls++;
      return calls <= 2;
    };
    const alias = generateAlias(isTaken, { words: ['comet'], random: () => 0 });
    expect(alias).toBe('comet-1');
    expect(calls).toBe(3);
  });

  it('throws ALIAS_GENERATION_FAILED once every attempt collides', () => {
    let error: unknown;
    try {
      generateAlias(() => true, { words: ['dune'], random: () => 0 });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CrontickError);
    expect((error as CrontickError).code).toBe('ALIAS_GENERATION_FAILED');
  });
});

describe('null-clears in the patch schema', () => {
  const full = () => existingJob({ kind: 'prompt', prompt: 'x', args: ['-v'], timeoutSec: 60, sessionId: 'sess-1', reuseSession: false, cwd: process.cwd() });

  it('accepts null for timeoutSec, sessionId, description only', () => {
    expect(JobPatchInputSchema.safeParse({ description: null }).success).toBe(true);
    expect(JobPatchInputSchema.safeParse({ action: { kind: 'prompt', timeoutSec: null, sessionId: null } }).success).toBe(true);
    for (const field of ['cwd', 'engine', 'prompt']) {
      expect(JobPatchInputSchema.safeParse({ action: { kind: 'prompt', [field]: null } }).success, field).toBe(false);
    }
    expect(JobPatchInputSchema.safeParse({ alias: null }).success).toBe(false);
    expect(JobPatchInputSchema.safeParse({ schedule: null }).success).toBe(false);
  });

  it('normalizeJobPatch removes timeoutSec and sessionId and keeps the rest', () => {
    const job = { ...full(), description: 'd' };
    const a = normalizeJobPatch(job.id, job, { action: { kind: 'prompt', timeoutSec: null } });
    expect(a.action).not.toHaveProperty('timeoutSec');
    expect(a.action).toMatchObject({ sessionId: 'sess-1', args: ['-v'] });
    const b = normalizeJobPatch(job.id, job, { action: { kind: 'prompt', sessionId: null } });
    expect(b.action).not.toHaveProperty('sessionId');
    expect(b.action).toMatchObject({ timeoutSec: 60 });
  });

  it('normalizeJobPatch removes description', () => {
    const job = { ...full(), description: 'd' };
    const out = normalizeJobPatch(job.id, job, { description: null });
    expect(out).not.toHaveProperty('description');
  });
});

describe('buildJobPatchFromUpdateOptions - unset', () => {
  it('maps each --unset field to null', () => {
    expect(buildJobPatchFromUpdateOptions(patchOpts({ unset: ['timeout'] })).action).toEqual({ kind: 'prompt', timeoutSec: null });
    expect(buildJobPatchFromUpdateOptions(patchOpts({ unset: ['session-id'] })).action).toEqual({ kind: 'prompt', sessionId: null });
    expect(buildJobPatchFromUpdateOptions(patchOpts({ unset: ['desc'] }))).toEqual({ description: null });
    const all = buildJobPatchFromUpdateOptions(patchOpts({ unset: ['timeout', 'session-id', 'desc'] }));
    expect(all).toEqual({ description: null, action: { kind: 'prompt', timeoutSec: null, sessionId: null } });
  });

  it('rejects unknown fields and conflicts with the setter flag', () => {
    expect(() => buildJobPatchFromUpdateOptions(patchOpts({ unset: ['cwd'] }))).toThrow(/Unknown --unset field "cwd"/);
    expect(() => buildJobPatchFromUpdateOptions(patchOpts({ unset: ['timeout'], timeout: 5 }))).toThrow(/--unset timeout.*--timeout/);
    expect(() => buildJobPatchFromUpdateOptions(patchOpts({ unset: ['session-id'], sessionId: 's' }))).toThrow(/--unset session-id.*--session-id/);
    expect(() => buildJobPatchFromUpdateOptions(patchOpts({ unset: ['desc'], desc: 'x' }))).toThrow(/--unset desc.*--desc/);
  });
});
