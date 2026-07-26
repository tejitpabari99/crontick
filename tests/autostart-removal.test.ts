import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve('.');
const removed = 'auto' + 'start';
const ignoredDirs = new Set(['.git', '.dev', '.crontick', 'dist', 'node_modules', 'coverage']);

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

  it('product source, packaged bin/exports surface, scripts, and plugin text do not expose removed surfaces', () => {
    // Scope: product code and the shipped/packaged surface only. docs/, specs/,
    // and examples/ are prose describing the removal, not the product itself, and
    // are intentionally NOT scanned -- scanning docs/ previously forced deletion
    // and rewording of legitimate ADR content (see docs/decisions/0003, commit
    // 9adbd63) and would break CI on the release PR the first time the pending
    // changeset (.changeset/purple-crabs-prompt.md) is consumed into CHANGELOG.md,
    // which is also excluded for the same reason. Every actual reappearance
    // vector (startup-registration code, a CLI flag, an MCP tool, a runtime
    // dependency) still lives in src/, plugin/, scripts/, or package.json, all of
    // which remain fully scanned below.
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const rel = relative(root, file).replace(/\\/g, '/');
      if (!/^(src|plugin|scripts|README\.md|package(?:-lock)?\.json|tsup\.config\.ts)/.test(rel)) continue;
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
    if (offenders.length > 0) {
      throw new Error(
        [
          `Found ${offenders.length} reference(s) to the removed startup-registration feature in shipped/product files:`,
          ...offenders.map((o) => `  - ${o}`),
          '',
          `This guard blocks the removed "${removed}" feature (OS login-item / registry-based daemon`,
          'launch) from reappearing in src/, plugin/, scripts/, README.md, package.json, package-lock.json,',
          'or tsup.config.ts. If this is a genuine reintroduction, it needs explicit sign-off per',
          '"Implementation rules" #1 in AGENTS.md before it can be added back. If this is an unrelated',
          'false-positive substring match, narrow the needle list or add a targeted exception here --',
          'do not delete or reword legitimate product code or documentation to dodge this test.',
        ].join('\n'),
      );
    }
  });
});
