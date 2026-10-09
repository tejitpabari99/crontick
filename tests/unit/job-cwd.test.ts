import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '../../src/client.js';
import { CrontickError } from '../../src/errors.js';
import { buildJobPatchFromUpdateOptions, normalizeJobInput, normalizeJobPatch, type JobCreateInput } from '../../src/job-input.js';
import type { Job } from '../../src/schemas/job.js';
import { FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';

const CLI = resolve('dist/cli/index.js');
const DAEMON_SCRIPT = resolve('dist/daemon/index.js');

const dirs: string[] = [];
function tmp(prefix = 'crontick-cwd-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    spawnSync(process.execPath, [CLI, 'daemon', 'stop'], { env: { ...process.env, CRONTICK_HOME: d } });
    rmSync(d, { recursive: true, force: true });
  }
});

function input(action: Record<string, unknown> = {}): JobCreateInput {
  return {
    schedule: { kind: 'interval', everySec: 3600 },
    action: { kind: 'prompt', prompt: 'hi', ...action },
  } as JobCreateInput;
}

describe('action.cwd normalization', () => {
  it('defaults to the caller cwd, resolved to an absolute path', () => {
    const base = tmp();
    expect(normalizeJobInput(input(), { cwd: base }).action.cwd).toBe(base);
    expect(normalizeJobInput(input()).action.cwd).toBe(process.cwd());
  });

  it('resolves a relative cwd against the caller cwd and requires an existing directory', () => {
    const base = tmp();
    mkdirSync(join(base, 'proj'));
    writeFileSync(join(base, 'afile'), 'x');
    expect(normalizeJobInput(input({ cwd: 'proj' }), { cwd: base }).action.cwd).toBe(join(base, 'proj'));
    for (const bad of ['missing', 'afile']) {
      try {
        normalizeJobInput(input({ cwd: bad }), { cwd: base });
        expect.unreachable();
      } catch (err) {
        expect((err as CrontickError).code).toBe('INVALID_CWD');
      }
    }
  });

  it('a cwd-only update patch changes only the cwd and never fills a default cwd on other updates', () => {
    const base = tmp();
    const other = tmp();
    const existing = normalizeJobInput(input(), { cwd: base }) as Job;
    const patch = buildJobPatchFromUpdateOptions({ cwd: other }, { cwd: base });
    const updated = normalizeJobPatch('x', existing, patch, { cwd: base });
    expect(updated.action).toMatchObject({ prompt: 'hi', cwd: other });
    const retouched = normalizeJobPatch('x', updated, { description: 'd' }, { cwd: base });
    expect(retouched.action.cwd).toBe(other);
    const promptOnly = normalizeJobPatch('x', updated, buildJobPatchFromUpdateOptions({ prompt: 'new' }, { cwd: base }), { cwd: base });
    expect(promptOnly.action).toMatchObject({ prompt: 'new', cwd: other });
  });

  it('rejects an update to a nonexistent cwd', () => {
    const existing = normalizeJobInput(input(), { cwd: tmp() }) as Job;
    expect(() => buildJobPatchFromUpdateOptions({ cwd: '/definitely/not/here' })).toThrow(/Working directory does not exist/);
    expect(() => normalizeJobPatch('x', existing, { action: { kind: 'prompt', cwd: '/definitely/not/here' } })).toThrow(/INVALID|does not exist/);
  });
});

describe('cwd change on a job with a session', () => {
  let a = '';
  let b = '';
  beforeEach(() => {
    a = tmp();
    b = tmp();
  });
  const sessionJob = (extra: Record<string, unknown>) => normalizeJobInput(input(extra), { cwd: a }) as Job;

  it('is rejected with CWD_CHANGE_BREAKS_SESSION for reuseSession or sessionId jobs', () => {
    for (const job of [sessionJob({ reuseSession: true }), sessionJob({ sessionId: 'sess-12345678' })]) {
      let error: unknown;
      try {
        normalizeJobPatch('x', job, buildJobPatchFromUpdateOptions({ cwd: b }, { cwd: a }), { cwd: a });
      } catch (err) {
        error = err;
      }
      expect((error as CrontickError).code).toBe('CWD_CHANGE_BREAKS_SESSION');
      expect((error as CrontickError).message).toContain('--session-id');
      expect((error as CrontickError).message).toContain('--reuse-session');
    }
  });

  it('is allowed with a new --session-id, or --reuse-session which resets the stored session', () => {
    const job = sessionJob({ sessionId: 'sess-12345678' });
    const withNew = normalizeJobPatch('x', job, buildJobPatchFromUpdateOptions({ cwd: b, sessionId: 'sess-other-0001' }, { cwd: a }), { cwd: a });
    expect(withNew.action).toMatchObject({ cwd: b, sessionId: 'sess-other-0001', reuseSession: false });
    const reset = normalizeJobPatch('x', job, buildJobPatchFromUpdateOptions({ cwd: b, reuseSession: true }, { cwd: a }), { cwd: a });
    expect(reset.action).toMatchObject({ cwd: b, reuseSession: true });
    expect(reset.action).not.toHaveProperty('sessionId');
  });

  it('does not apply when the cwd is unchanged or the job has no session', () => {
    const job = sessionJob({ sessionId: 'sess-12345678' });
    expect(() => normalizeJobPatch('x', job, buildJobPatchFromUpdateOptions({ cwd: a }, { cwd: a }), { cwd: a })).not.toThrow();
    const plain = sessionJob({});
    expect(() => normalizeJobPatch('x', plain, buildJobPatchFromUpdateOptions({ cwd: b }, { cwd: a }), { cwd: a })).not.toThrow();
  });
});

describe('--dir on the CLI', () => {
  function cli(args: string[], home: string, cwd?: string) {
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf-8',
      cwd,
      env: { ...process.env, CRONTICK_HOME: home, CRONTICK_VERBOSE: '' },
      timeout: 30_000,
    });
  }

  it('stores the invoking directory by default, honors --dir, rejects missing dirs, and runs start there', async () => {
    const home = tmp('crontick-cwd-home-');
    writeFakeEngineConfig(home);
    const invoking = tmp();
    const chosen = tmp();
    const common = ['--runner', FAKE_ENGINE_NAME, '--every', '1h'];

    expect(cli(['jobs', 'new', '-a', 'cwd-default', '-p', 'console.log(process.cwd())', ...common], home, invoking).status).toBe(0);
    expect(cli(['jobs', 'get', 'cwd-default'], home).stdout).toContain(`"cwd":${JSON.stringify(invoking)}`);

    expect(cli(['jobs', 'new', '-a', 'cwd-chosen', '-p', 'console.log(process.cwd())', '--dir', chosen, ...common], home, invoking).status).toBe(0);
    expect(cli(['jobs', 'get', 'cwd-chosen'], home).stdout).toContain(`"cwd":${JSON.stringify(chosen)}`);

    const missing = cli(['jobs', 'new', '-a', 'cwd-missing', '-p', 'x', '--dir', join(chosen, 'nope'), ...common], home, invoking);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('INVALID_CWD');
    expect(cli(['jobs', 'get', 'cwd-missing'], home).status).toBe(1);

    const moved = cli(['jobs', 'update', 'cwd-default', '--dir', chosen], home, invoking);
    expect(moved.status, moved.stderr).toBe(0);
    expect(moved.stdout).toContain(`"cwd":${JSON.stringify(chosen)}`);
    expect(moved.stdout).toContain('console.log(process.cwd())');

    const schedule = cli(['jobs', 'schedule', 'cwd-chosen'], home);
    expect(schedule.stdout).toContain(`cwd: ${chosen}`);

    const client = createClient({ env: { ...process.env, CRONTICK_HOME: home }, daemonScript: DAEMON_SCRIPT, startupTimeoutMs: 15_000 });
    const { runId } = await client.runNow('cwd-chosen');
    const deadline = Date.now() + 15_000;
    let status = 'queued';
    while (Date.now() < deadline && (status === 'queued' || status === 'running')) {
      await new Promise((r) => setTimeout(r, 100));
      status = (await client.getRun(runId)).status;
    }
    expect(status).toBe('success');
    expect((await client.getOutput(runId)).result).toContain(chosen);
  }, 60_000);
});
