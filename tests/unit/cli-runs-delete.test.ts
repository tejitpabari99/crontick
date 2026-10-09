import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../../src/daemon/api.js';
import type { Runner } from '../../src/daemon/runner.js';
import { Scheduler } from '../../src/daemon/scheduler.js';
import { Store } from '../../src/daemon/store.js';
import type { Job } from '../../src/schemas/job.js';
import { deleteRunsWithConfirm, type ConfirmIo } from '../../src/cli/confirm.js';

type DeleteResult = { deleted: string[]; skipped: Array<{ id: string; status: string }>; notFound: string[]; jobLogRemoved: boolean };

function fakeClient(preview: Partial<DeleteResult> = {}) {
  const calls: Array<{ runIds?: string[]; job?: string; dryRun?: boolean }> = [];
  const result = (dryRun: boolean | undefined): DeleteResult => ({ deleted: ['a', 'b'], skipped: [], notFound: [], jobLogRemoved: false, ...preview, ...(dryRun ? {} : {}) });
  return {
    calls,
    async deleteRuns(opts: { runIds?: string[]; job?: string; dryRun?: boolean }) { calls.push(opts); return result(opts.dryRun); },
  };
}

function io(interactive: boolean, answer = ''): ConfirmIo & { questions: string[] } {
  const questions: string[] = [];
  return { interactive, questions, async ask(q) { questions.push(q); return answer; } };
}

describe('deleteRunsWithConfirm', () => {
  it.each(['y', 'YES'])('answer %s dry-runs, prompts with counts, then deletes', async (answer) => {
    const c = fakeClient(); const i = io(true, answer);
    const res = await deleteRunsWithConfirm(c, { runIds: ['a', 'b'] }, i);
    expect(i.questions).toEqual(['Delete 2 run(s)? (y/N) ']);
    expect(c.calls.map((x) => x.dryRun === true)).toEqual([true, false]);
    expect(res.deleted).toEqual(['a', 'b']);
  });

  it('mentions the job in the prompt', async () => {
    const c = fakeClient(); const i = io(true, 'y');
    await deleteRunsWithConfirm(c, { job: 'nightly' }, i);
    expect(i.questions).toEqual(['Delete 2 run(s) of job nightly? (y/N) ']);
  });

  it.each(['', 'n', 'no'])('answer "%s" declines without deleting', async (answer) => {
    const c = fakeClient(); const i = io(true, answer);
    await expect(deleteRunsWithConfirm(c, { runIds: ['a'] }, i)).rejects.toMatchObject({ code: 'CONFIRMATION_DECLINED' });
    expect(c.calls.every((x) => x.dryRun === true)).toBe(true);
  });

  it('non-TTY without --force fails CONFIRMATION_REQUIRED and calls nothing', async () => {
    const c = fakeClient();
    await expect(deleteRunsWithConfirm(c, { runIds: ['a'] }, io(false))).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(c.calls).toEqual([]);
  });

  it('--force deletes with no prompt, even non-TTY', async () => {
    const c = fakeClient(); const i = io(false);
    await deleteRunsWithConfirm(c, { runIds: ['a'], force: true }, i);
    expect(c.calls).toEqual([{ runIds: ['a'], dryRun: false }]);
    expect(i.questions).toEqual([]);
  });

  it('--dry-run only previews, no prompt', async () => {
    const c = fakeClient(); const i = io(false);
    await deleteRunsWithConfirm(c, { job: 'x', dryRun: true }, i);
    expect(c.calls).toEqual([{ job: 'x', dryRun: true }]);
    expect(i.questions).toEqual([]);
  });
});

// ── CLI process tests against an in-process API server ───────────────────────
const CLI = resolve('dist/cli/index.js');
const SCRATCH = resolve('.crontick', 'cli-runs-delete');
let home: string;
let store: Store;
let server: ReturnType<typeof createApiServer> | undefined;
let url: string;

beforeEach(async () => {
  home = resolve(SCRATCH, randomUUID());
  mkdirSync(join(home, 'jobs'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
  store = new Store(join(home, 'runs.db'), join(home, 'jobs'));
  store.open();
  const ctx = {
    store, scheduler: new Scheduler(),
    runner: { run: async () => {}, cancelJob: () => false, cancelRun: () => false } as unknown as Runner,
    startedAt: new Date(), port: 0, reload: async () => {},
  };
  server = createApiServer(ctx);
  await new Promise<void>((res, rej) => { server!.listen(0, '127.0.0.1', () => res()); server!.on('error', rej); });
  ctx.port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${ctx.port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  rmSync(home, { recursive: true, force: true });
});

function seed(alias: string): { jobId: string; runs: string[] } {
  const j: Job = {
    id: randomUUID(), alias, description: '', enabled: true,
    schedule: { kind: 'cron', cron: '0 0 * * *' },
    action: { kind: 'prompt', prompt: 'noop', args: [], reuseSession: false },
    overlap: 'skip', retry: { max: 0, backoffSec: 30 },
  };
  store.upsertJob(j);
  const runs = [0, 1].map(() => {
    const r = store.insertRun(j.id);
    store.updateRun(r.id, { status: 'success', endedAt: Date.now() });
    return r.id;
  });
  return { jobId: j.id, runs };
}

function cli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, CRONTICK_HOME: home, CRONTICK_DAEMON_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolveP({ status, stdout, stderr }));
  });
}

describe('crontick runs delete (CLI process)', () => {
  it('non-TTY without --force fails CONFIRMATION_REQUIRED, exit 1, nothing deleted', async () => {
    const { runs } = seed('cd-a');
    const res = await cli(['runs', 'delete', runs[0]!]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('[CONFIRMATION_REQUIRED]');
    expect(store.getRun(runs[0]!)).toBeDefined();
  });

  it('--force deletes and prints the summary line', async () => {
    const { runs } = seed('cd-b');
    const res = await cli(['runs', 'delete', runs[0]!, runs[1]!, '--force']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim()).toBe('Deleted 2 run(s); skipped 0 active; not found 0.');
    expect(store.getRun(runs[0]!)).toBeUndefined();
  });

  it('--job with --dry-run previews without deleting', async () => {
    const { runs } = seed('cd-c');
    const res = await cli(['runs', 'delete', '--job', 'cd-c', '--dry-run']);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('2 run(s)');
    expect(store.getRun(runs[0]!)).toBeDefined();
  });

  it('--json prints the full result; unknown id exits 1 but still prints', async () => {
    const { runs } = seed('cd-d');
    const res = await cli(['runs', 'delete', runs[0]!, 'missing-id', '--force', '--json']);
    expect(res.status).toBe(1);
    const parsed = JSON.parse(res.stdout) as DeleteResult;
    expect(parsed.deleted).toEqual([runs[0]]);
    expect(parsed.notFound).toEqual(['missing-id']);
  });

  it('plain output reports not found and exits 1', async () => {
    seed('cd-e');
    const res = await cli(['runs', 'delete', 'missing-id', '--force']);
    expect(res.status).toBe(1);
    expect(res.stdout.trim()).toBe('Deleted 0 run(s); skipped 0 active; not found 1.');
  });

  it('requires run ids or --job', async () => {
    const res = await cli(['runs', 'delete', '--force']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('error');
  });
});
