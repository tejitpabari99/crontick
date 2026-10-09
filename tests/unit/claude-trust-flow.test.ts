import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '../../src/client.js';
import { FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';

const CLI = resolve('dist/cli/index.js');
const DAEMON_SCRIPT = resolve('dist/daemon/index.js');

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

interface Sandbox {
  home: string;
  claudeDir: string;
  claudeJson: string;
  env: NodeJS.ProcessEnv;
  project: string;
}

/** Scratch CRONTICK_HOME + scratch Claude config (nothing trusted) + a project folder. The real ~/.claude.json is never involved. */
function sandbox(): Sandbox {
  const home = tmp('crontick-trust-home-');
  const claudeDir = tmp('crontick-trust-claude-');
  const claudeJson = join(claudeDir, '.claude.json');
  writeFileSync(claudeJson, `${JSON.stringify({ numStartups: 7, theme: 'dark', projects: { '/elsewhere': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] } } }, null, 2)}\n`);
  writeFakeEngineConfig(home);
  return { home, claudeDir, claudeJson, env: { ...process.env, CRONTICK_HOME: home, CLAUDE_CONFIG_DIR: claudeDir }, project: tmp('crontick-trust-proj-') };
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    spawnSync(process.execPath, [CLI, 'daemon', 'stop'], { env: { ...process.env, CRONTICK_HOME: d } });
    rmSync(d, { recursive: true, force: true });
  }
});

const readClaude = (sb: Sandbox) => JSON.parse(readFileSync(sb.claudeJson, 'utf-8')) as { numStartups: number; theme: string; projects: Record<string, { hasTrustDialogAccepted: boolean }> };

describe('Claude folder trust through the client', () => {
  const jobIn = (cwd: string, engine?: string) => ({
    alias: `trust-${engine ?? 'claude'}`,
    schedule: { kind: 'interval' as const, everySec: 3600 },
    action: { kind: 'prompt' as const, prompt: 'hi', args: [], reuseSession: false, cwd, ...(engine ? { engine } : {}) },
  });

  it('createJob throws TRUST_REQUIRED before persisting; trustFolder:true trusts the folder and creates the job', async () => {
    const sb = sandbox();
    const client = createClient({ env: sb.env, daemonScript: DAEMON_SCRIPT, startupTimeoutMs: 15_000 });
    const before = readFileSync(sb.claudeJson, 'utf-8');

    await expect(client.createJob(jobIn(sb.project))).rejects.toMatchObject({
      code: 'TRUST_REQUIRED',
      message: expect.stringContaining(`Folder ${sb.project} is not trusted by Claude`),
      details: { cwd: sb.project, engine: 'claude' },
    });
    expect(await client.listJobs()).toEqual([]);
    expect(readFileSync(sb.claudeJson, 'utf-8')).toBe(before);

    const created = await client.createJob(jobIn(sb.project), { trustFolder: true });
    expect(created.action.cwd).toBe(sb.project);
    const after = readClaude(sb);
    expect(after.projects[sb.project]).toEqual({ allowedTools: [], hasTrustDialogAccepted: true });
    expect(after.projects['/elsewhere']).toEqual({ hasTrustDialogAccepted: true, allowedTools: ['Bash'] });
    expect(after.numStartups).toBe(7);

    // Now trusted: a second job in the same folder needs no flag.
    await expect(client.createJob({ ...jobIn(sb.project), alias: 'second' })).resolves.toMatchObject({ alias: 'second' });
  }, 60_000);

  it('a descendant of a trusted folder is trusted; engines without trust hooks skip the check', async () => {
    const sb = sandbox();
    const client = createClient({ env: sb.env, daemonScript: DAEMON_SCRIPT, startupTimeoutMs: 15_000 });
    writeFileSync(sb.claudeJson, JSON.stringify({ projects: { [sb.project]: { hasTrustDialogAccepted: true } } }));
    const nested = join(sb.project, 'nested');
    mkdirSync(nested);
    await expect(client.createJob({ ...jobIn(nested), alias: 'nested-ok' })).resolves.toMatchObject({ alias: 'nested-ok' });

    const sb2 = sandbox();
    const client2 = createClient({ env: sb2.env, daemonScript: DAEMON_SCRIPT, startupTimeoutMs: 15_000 });
    await expect(client2.createJob(jobIn(sb2.project, FAKE_ENGINE_NAME))).resolves.toMatchObject({ alias: `trust-${FAKE_ENGINE_NAME}` });
    expect(readClaude(sb2).projects[sb2.project]).toBeUndefined();
  }, 60_000);

  it('updateJob checks trust only when the cwd or engine changes', async () => {
    const sb = sandbox();
    const client = createClient({ env: sb.env, daemonScript: DAEMON_SCRIPT, startupTimeoutMs: 15_000 });
    await client.createJob(jobIn(sb.project), { trustFolder: true });
    const other = tmp('crontick-trust-other-');

    await expect(client.updateJob('trust-claude', { action: { kind: 'prompt', cwd: other } })).rejects.toMatchObject({ code: 'TRUST_REQUIRED' });
    expect((await client.getJob('trust-claude')).action.cwd).toBe(sb.project);

    // Untrust the original folder: a description-only update must not care.
    writeFileSync(sb.claudeJson, JSON.stringify({ projects: {} }));
    await expect(client.updateJob('trust-claude', { description: 'still fine' })).resolves.toMatchObject({ description: 'still fine' });

    await expect(client.updateJob('trust-claude', { action: { kind: 'prompt', cwd: other } }, { trustFolder: true }))
      .resolves.toMatchObject({ action: { cwd: other } });
    expect(readClaude(sb).projects[other]?.hasTrustDialogAccepted).toBe(true);
  }, 60_000);

  it('CLAUDE_CONFIG_UNREADABLE aborts without creating the job or touching the file', async () => {
    const sb = sandbox();
    const client = createClient({ env: sb.env, daemonScript: DAEMON_SCRIPT, startupTimeoutMs: 15_000 });
    writeFileSync(sb.claudeJson, '{ broken');
    await expect(client.createJob(jobIn(sb.project), { trustFolder: true })).rejects.toMatchObject({ code: 'CLAUDE_CONFIG_UNREADABLE' });
    expect(readFileSync(sb.claudeJson, 'utf-8')).toBe('{ broken');
    expect(await client.listJobs()).toEqual([]);
  }, 60_000);
});

describe('Claude folder trust on import', () => {
  it('checks each distinct folder once before importing anything; trustFolder:true trusts them all', async () => {
    const sb = sandbox();
    const client = createClient({ env: sb.env, daemonScript: DAEMON_SCRIPT, startupTimeoutMs: 15_000 });
    const other = tmp('crontick-trust-import-other-');
    const job = (alias: string, cwd: string) => ({ alias, schedule: { kind: 'interval', everySec: 3600 }, action: { kind: 'prompt', prompt: 'hi', cwd } });
    const file = { schema: 1, jobs: [job('imp-a', sb.project), job('imp-b', sb.project), job('imp-c', other)] };

    await expect(client.importJobs(file)).rejects.toMatchObject({
      code: 'TRUST_REQUIRED',
      details: { folders: [sb.project, other] },
    });
    expect(await client.listJobs()).toEqual([]);

    const result = await client.importJobs(file, { trustFolder: true });
    expect(result.imported).toBe(3);
    const claude = JSON.parse(readFileSync(sb.claudeJson, 'utf-8')) as { projects: Record<string, { hasTrustDialogAccepted: boolean }> };
    expect(claude.projects[sb.project]?.hasTrustDialogAccepted).toBe(true);
    expect(claude.projects[other]?.hasTrustDialogAccepted).toBe(true);
  }, 60_000);
});

describe('--trust-folder on the CLI (non-interactive)', () => {
  function cli(sb: Sandbox, args: string[]) {
    return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', cwd: sb.project, env: { ...sb.env, CRONTICK_VERBOSE: '' }, timeout: 30_000 });
  }

  it('errors with TRUST_REQUIRED and a re-run hint, creating nothing; --trust-folder succeeds', () => {
    const sb = sandbox();
    const denied = cli(sb, ['jobs', 'new', '-a', 'cli-trust', '-p', 'hi', '--every', '1h']);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('TRUST_REQUIRED');
    expect(denied.stderr).toContain('--trust-folder');
    expect(denied.stderr).toContain(sb.project);
    expect(cli(sb, ['jobs', 'get', 'cli-trust']).status).toBe(1);
    expect(readClaude(sb).projects[sb.project]).toBeUndefined();

    const ok = cli(sb, ['jobs', 'new', '-a', 'cli-trust', '-p', 'hi', '--every', '1h', '--trust-folder']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(readClaude(sb).projects[sb.project]?.hasTrustDialogAccepted).toBe(true);

    const other = tmp('crontick-trust-cli-other-');
    const upd = cli(sb, ['jobs', 'update', 'cli-trust', '--dir', other]);
    expect(upd.status).toBe(1);
    expect(upd.stderr).toContain('TRUST_REQUIRED');
    const upd2 = cli(sb, ['jobs', 'update', 'cli-trust', '--dir', other, '--trust-folder']);
    expect(upd2.status, upd2.stderr).toBe(0);
  }, 90_000);

  it('raw-engine jobs never ask', () => {
    const sb = sandbox();
    const ok = cli(sb, ['jobs', 'new', '-a', 'raw-job', '-p', 'x', '--runner', FAKE_ENGINE_NAME, '--every', '1h']);
    expect(ok.status, ok.stderr).toBe(0);
  }, 60_000);
});
