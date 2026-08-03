import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeJobInput } from '../../src/job-input.js';
import type { JobCreateInput } from '../../src/job-input.js';

/**
 * Guards the deliberate *exposure narrowing* of script/exec actions: the
 * dedicated CLI convenience flags (--script/--exec/--arg/--shell/--job-env-file)
 * were removed, but script and exec actions remain first-class in the job schema,
 * the daemon executors, and the core client -- creatable via `jobs new --file`
 * (a full job JSON) or the library `createJob`. Per AGENTS.md rule 8 this is
 * exposure narrowing, not feature removal, so these tests assert BOTH: the flags
 * are gone AND the underlying capability still works.
 */

const CLI = resolve('dist/cli/index.js');

function cli(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

const REMOVED_JOB_FLAGS = ['--script', '--exec', '--arg', '--shell', '--job-env-file'] as const;

describe('script/exec CLI exposure removal', () => {
  it('the CLI no longer registers the removed job-authoring flags', () => {
    const source = readFileSync(resolve('src/cli/index.ts'), 'utf-8');
    for (const flag of REMOVED_JOB_FLAGS) {
      expect(source, `CLI must not register ${flag}`).not.toContain(`.option('${flag}`);
      expect(source, `CLI must not register ${flag}`).not.toContain(`.option("${flag}`);
    }
  });

  it('`jobs new` rejects each removed flag as an unknown option (clean error, exit 1)', () => {
    for (const flag of REMOVED_JOB_FLAGS) {
      const result = cli(['jobs', 'new', flag, 'value']);
      expect(result.status, `${flag}: ${result.stderr}`).toBe(1);
      expect(result.stderr).toContain('error:');
      expect(result.stderr).toContain('unknown option');
      expect(result.stderr).toContain(flag);
      // No Node stack trace leaks to the user.
      expect(result.stderr).not.toMatch(/\n\s+at\s/);
    }
  });

  it('`jobs update` also rejects the removed flags as unknown options', () => {
    for (const flag of REMOVED_JOB_FLAGS) {
      const result = cli(['jobs', 'update', 'some-alias', flag, 'value']);
      expect(result.status, `${flag}: ${result.stderr}`).toBe(1);
      expect(result.stderr).toContain('unknown option');
      expect(result.stderr).toContain(flag);
    }
  });

  it('core still supports a script action (via the schema/normalizer used by --file and createJob)', () => {
    const input: JobCreateInput = {
      alias: 'script-job',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      action: { kind: 'script', script: 'echo hello', shell: 'bash' },
    } as JobCreateInput;
    const job = normalizeJobInput(input);
    expect(job.action.kind).toBe('script');
    expect(job.id).toBeTruthy();
  });

  it('core still supports an exec action (via the schema/normalizer used by --file and createJob)', () => {
    const input: JobCreateInput = {
      alias: 'exec-job',
      schedule: { kind: 'interval', everySec: 60 },
      action: { kind: 'exec', command: 'node', args: ['-e', 'process.exit(0)'] },
    } as JobCreateInput;
    const job = normalizeJobInput(input);
    expect(job.action.kind).toBe('exec');
    expect(job.id).toBeTruthy();
  });
});
