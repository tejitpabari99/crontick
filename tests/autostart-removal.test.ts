import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve('.');
const removed = 'auto' + 'start';
const ignoredDirs = new Set(['.git', '.dev', 'dist', 'node_modules', 'coverage']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walk(path));
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

describe('startup registration removal guards', () => {
  it('package metadata has no registry dependency', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      expect(pkg[field]?.['registry' + '-js']).toBeUndefined();
    }
    expect(readFileSync(join(root, 'tsup.config.ts'), 'utf-8')).not.toContain('registry' + '-js');
  });

  it('public source, docs, scripts, and plugin text do not expose removed surfaces', () => {
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const rel = relative(root, file).replace(/\\/g, '/');
      if (!/^(src|docs|plugin|scripts|README\.md|CHANGELOG\.md|package(?:-lock)?\.json|tsup\.config\.ts)/.test(rel)) continue;
      const text = readFileSync(file, 'utf-8').toLowerCase();
      for (const needle of [
        removed,
        'registry' + '-js',
        'reg' + '.exe',
        'login ' + 'item',
        'allow' + 'start',
        'no-daemon-start',
        'crontick_mcp_no_daemon_start',
        'maxtokensperrun',
      ]) {
        if (text.includes(needle)) offenders.push(`${rel}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
