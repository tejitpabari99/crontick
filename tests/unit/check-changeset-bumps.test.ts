/**
 * Release guard: scripts/check-changeset-bumps.mjs blocks pending `major`
 * changesets by default (unless ALLOW_MAJOR=true), and supports a stricter
 * MAX_BUMP ceiling. Exercises the real script via spawnSync against temp
 * fixture directories, matching this repo's convention for testing scripts/.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve('scripts/check-changeset-bumps.mjs');
const cleanupDirs: string[] = [];

function makeChangesetDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'crontick-changeset-guard-'));
  cleanupDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf-8');
  }
  return dir;
}

function run(dir: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, dir], {
    encoding: 'utf8',
    env: { ...process.env, ALLOW_MAJOR: undefined, MAX_BUMP: undefined, ...env },
  });
}

const PATCH_CHANGESET = '---\n"crontick": patch\n---\n\nA small fix.\n';
const MINOR_CHANGESET = '---\n"crontick": minor\n---\n\nA new feature.\n';
const MAJOR_CHANGESET = '---\n"crontick": major\n---\n\nA breaking change.\n';

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('check-changeset-bumps', () => {
  it('passes when no changesets are pending', () => {
    const dir = makeChangesetDir({});
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK');
  });

  it('passes for patch and minor changesets by default', () => {
    const dir = makeChangesetDir({ 'a.md': PATCH_CHANGESET, 'b.md': MINOR_CHANGESET });
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('2 changeset(s) checked');
  });

  it('ignores README.md and non-.md files in the changeset directory', () => {
    const dir = makeChangesetDir({
      'README.md': 'Not a changeset, human docs only.',
      'a.md': PATCH_CHANGESET,
    });
    writeFileSync(join(dir, 'config.json'), '{}', 'utf-8');
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 changeset(s) checked');
  });

  it('fails and lists offending files when a major bump is pending', () => {
    const dir = makeChangesetDir({ 'ok.md': PATCH_CHANGESET, 'breaking.md': MAJOR_CHANGESET });
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('breaking.md');
    expect(result.stderr).toContain('major');
    expect(result.stderr).not.toContain('ok.md declares');
  });

  it('allows a major bump when ALLOW_MAJOR=true', () => {
    const dir = makeChangesetDir({ 'breaking.md': MAJOR_CHANGESET });
    const result = run(dir, { ALLOW_MAJOR: 'true' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK');
  });

  it('blocks minor bumps when MAX_BUMP=patch even without a major changeset', () => {
    const dir = makeChangesetDir({ 'feature.md': MINOR_CHANGESET });
    const result = run(dir, { MAX_BUMP: 'patch' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('feature.md');
    expect(result.stderr).toContain('minor');
  });

  it('lets an explicit MAX_BUMP take precedence over ALLOW_MAJOR', () => {
    const dir = makeChangesetDir({ 'breaking.md': MAJOR_CHANGESET });
    const result = run(dir, { ALLOW_MAJOR: 'true', MAX_BUMP: 'patch' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('breaking.md');
  });

  it('rejects an invalid MAX_BUMP value', () => {
    const dir = makeChangesetDir({ 'ok.md': PATCH_CHANGESET });
    const result = run(dir, { MAX_BUMP: 'bogus' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid MAX_BUMP value');
  });

  it('treats a directory that does not exist as having no changesets', () => {
    const result = run(resolve('does-not-exist-changeset-dir'));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0 changeset(s) checked');
  });
});
