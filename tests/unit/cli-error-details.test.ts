import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = resolve('dist/cli/index.js');
const INVALID_JOB_ALIAS = 'QA_Job_011_Bad';
const ALIAS_ERROR_MESSAGE = 'Job alias must be kebab-case (e.g. "my-job")';

function cli(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env },
  });
}

function invalidCreateArgs(): string[] {
  return ['jobs', 'new', '--alias', INVALID_JOB_ALIAS, '--every', '3600', '--prompt', 'hello'];
}

describe('CLI error details', () => {
  it('validation errors print the normalized one-line headline', () => {
    const result = cli(invalidCreateArgs());

    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('error: [VALIDATION_ERROR] Invalid job');
    expect(result.stderr).not.toContain('Details:');
  });

  it('--verbose validation errors print field-level Details lines', () => {
    const result = cli(['--verbose', ...invalidCreateArgs()]);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('error: [VALIDATION_ERROR] Invalid job');
    expect(result.stderr).toContain('Details:');
    expect(result.stderr).toContain(`- alias: ${ALIAS_ERROR_MESSAGE}`);
  });

  it('an invalid integer option value fails cleanly (exit 1, no stack trace)', () => {
    const result = cli(['jobs', 'new', '--alias', 'good-alias', '--every', 'abc', '--prompt', 'hello']);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe('');
    // Commander's InvalidArgumentError is rendered as a single clean red line.
    expect(result.stderr).toContain('Invalid interval: abc');
    expect(result.stderr.trim().startsWith('error:')).toBe(true);
    expect(result.stderr).not.toContain('at '); // no Node stack frames
  });
});
