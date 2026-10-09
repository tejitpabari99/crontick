import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureFoldersTrusted, prepareCreate, prepareUpdate, trustTarget } from '../../src/job-prepare.js';

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sandbox() {
  const home = tmp('jp-home-');
  const claudeDir = tmp('jp-claude-');
  const claudeJson = join(claudeDir, '.claude.json');
  writeFileSync(claudeJson, `${JSON.stringify({ projects: {} })}\n`);
  const env = { ...process.env, CRONTICK_HOME: home, CLAUDE_CONFIG_DIR: claudeDir };
  return { env, claudeJson, project: tmp('jp-proj-') };
}

const input = (cwd: string) => ({
  alias: 'jp',
  schedule: { kind: 'interval' as const, everySec: 3600 },
  action: { kind: 'prompt' as const, prompt: 'hi', args: [], reuseSession: false, cwd },
});

describe('job-prepare', () => {
  it('prepareCreate normalizes and throws TRUST_REQUIRED for an untrusted folder', () => {
    const sb = sandbox();
    const resolveJob = vi.fn();
    expect(() => prepareCreate(input(sb.project), { env: sb.env, resolveJob })).toThrowError(
      expect.objectContaining({ code: 'TRUST_REQUIRED', details: expect.objectContaining({ cwd: sb.project }) }),
    );
    expect(resolveJob).not.toHaveBeenCalled();
  });

  it('prepareCreate with trustFolder trusts the folder and returns a finished job', () => {
    const sb = sandbox();
    const job = prepareCreate(input(sb.project), { env: sb.env, trustFolder: true, resolveJob: () => undefined });
    expect(job.id).toBeTruthy();
    expect(job.retry).toBeDefined();
    expect(JSON.parse(readFileSync(sb.claudeJson, 'utf-8')).projects[sb.project].hasTrustDialogAccepted).toBe(true);
    expect(trustTarget(job, { env: sb.env })?.key).toContain(sb.project);
  });

  it('prepareUpdate only checks trust when the engine/folder key changes', () => {
    const sb = sandbox();
    const existing = prepareCreate(input(sb.project), { env: sb.env, trustFolder: true, resolveJob: () => undefined });
    const same = prepareUpdate(existing, { description: 'x' }, { env: sb.env, resolveJob: () => undefined });
    expect(same.description).toBe('x');
    const other = tmp('jp-other-');
    expect(() => prepareUpdate(existing, { action: { kind: 'prompt', cwd: other } }, { env: sb.env, resolveJob: () => undefined })).toThrowError(
      expect.objectContaining({ code: 'TRUST_REQUIRED' }),
    );
  });

  it('ensureFoldersTrusted lists every untrusted folder once', () => {
    const sb = sandbox();
    const a = prepareCreate(input(sb.project), { env: sb.env, trustFolder: true, resolveJob: () => undefined });
    const other = tmp('jp-o2-');
    const b = { ...a, action: { ...a.action, cwd: other } };
    expect(() => ensureFoldersTrusted([b, b], { env: sb.env }, false)).toThrowError(
      expect.objectContaining({ code: 'TRUST_REQUIRED', details: expect.objectContaining({ folders: [other] }) }),
    );
  });
});
