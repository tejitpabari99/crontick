import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve('.');
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

describe('startup registration guards (autostart is opt-in only)', () => {
  it('package metadata has no registry dependency', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      expect(pkg[field]?.['registry' + '-js']).toBeUndefined();
    }
    expect(readFileSync(join(root, 'tsup.config.ts'), 'utf-8')).not.toContain('registry' + '-js');
  });

  it('product source, packaged bin/exports surface, scripts, and plugin text do not expose removed surfaces', () => {
    // Scope: product code and the shipped/packaged surface only. docs/, specs/,
    // and examples/ are prose and intentionally NOT scanned (CHANGELOG.md too).
    // Opt-in autostart is allowed (AGENTS.md rule 8 sign-off, ADR 0034); the old
    // risky mechanisms (native registry dep, Run key, VBS shim, admin tooling) stay banned.
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const rel = relative(root, file).replace(/\\/g, '/');
      if (!/^(src|plugin|scripts|README\.md|package(?:-lock)?\.json|tsup\.config\.ts)/.test(rel)) continue;
      let text = readFileSync(file, 'utf-8').toLowerCase();
      // Targeted exception: Task Scheduler schema elements AllowStartOnDemand and
      // DisallowStartIfOnBatteries are unrelated to the removed allowstart surface.
      if (rel === 'src/autostart/taskxml.ts') text = text.replaceAll('allowstartondemand', '').replaceAll('disallowstartifonbatteries', '');
      for (const needle of [
        'registry' + '-js',
        'reg' + '.exe',
        'hk' + 'cu',
        'currentversion' + '\\run',
        'wscript',
        '.' + 'vbs',
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
          `Found ${offenders.length} reference(s) to a forbidden startup mechanism in shipped/product files:`,
          ...offenders.map((o) => `  - ${o}`),
          '',
          'Opt-in autostart (`crontick autostart enable|disable|status`) is allowed, but it must not use a native',
          'registry dependency, reg.exe, the Windows Run key (HKCU ...\\CurrentVersion\\Run), a VBS/wscript shim,',
          'or the removed allowstart / no-daemon-start / maxTokensPerRun surfaces. Guarded in src/, plugin/, scripts/,',
          'README.md, package.json, package-lock.json, and tsup.config.ts. If this is an unrelated false-positive',
          'substring match, narrow the needle list or add a targeted exception here -- do not delete or reword',
          'legitimate product code to dodge this test.',
        ].join('\n'),
      );
    }
  });

  it('autostart is opt-in: no daemon code references it, and only the CLI shim calls enable', () => {
    const offenders: string[] = [];
    for (const file of walk(join(root, 'src'))) {
      const rel = relative(root, file).replace(/\\/g, '/');
      const text = readFileSync(file, 'utf-8');
      if (rel.startsWith('src/daemon/') && /autostart/i.test(text)) offenders.push(`${rel}: daemon must not reference autostart`);
      if (/autostartEnable\(/.test(text) && !/^src\/(cli\/|client\.ts$)/.test(rel)) offenders.push(`${rel}: autostartEnable called outside CLI shim`);
    }
    // Inside client.ts, enable must be defined but never invoked implicitly (e.g. on start/ensureDaemon).
    const client = readFileSync(join(root, 'src/client.ts'), 'utf-8');
    expect(client.match(/\.autostartEnable\(/g) ?? []).toEqual([]);
    expect(offenders).toEqual([]);
  });
});
