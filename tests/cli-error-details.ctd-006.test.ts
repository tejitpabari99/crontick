import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = resolve('dist/cli/index.js');
const INVALID_JOB_ID = 'QA_Job_011_Bad';
const ID_ERROR_MESSAGE = 'Job ID must be kebab-case (e.g. "my-job")';

function cli(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env },
  });
}

describe('CTD-006 CLI error details', () => {
  it('text-mode validation errors print the headline plus field-level details', () => {
    const result = cli(['new', INVALID_JOB_ID, '--every', '3600', '--exec', 'node', '--arg', '--version']);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Error [VALIDATION_ERROR]: Invalid job');
    expect(result.stderr).toContain('Details:');
    expect(result.stderr).toContain(`id: ${ID_ERROR_MESSAGE}`);
  });

  it('--json validation errors preserve the full structured payload including details', () => {
    const result = cli(['--json', 'new', INVALID_JOB_ID, '--every', '3600', '--exec', 'node', '--arg', '--version']);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe('');

    const payload = JSON.parse(result.stderr) as {
      code: string;
      message: string;
      details?: { id?: { _errors?: string[] } };
    };

    expect(payload).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Invalid job',
    });
    expect(payload.details?.id?._errors).toContain(ID_ERROR_MESSAGE);
  });
});
