/**
 * Rebrand check: no stale legacy product-name references in src/, plugin/, tests/.
 * Does NOT check docs/plan/v1/ (historical artifacts).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const STALE_PATTERNS = [
  new RegExp(`cron-${'job'}(?!\\.test)`),
  new RegExp(`@cron${'js'}/`),
  new RegExp(`cron\\s+${'cli'}`, 'i'),
];

function collectTextFiles(dir: string, exts = ['.ts', '.js', '.json', '.md']): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
        files.push(...collectTextFiles(full, exts));
      } else if (exts.includes(extname(entry.name))) {
        files.push(full);
      }
    }
  } catch {
    // ignore missing roots
  }
  return files;
}

describe('Rebrand: no stale references', () => {
  const roots = ['src', 'plugin', 'tests'].map((d) => join(process.cwd(), d));
  const allFiles = roots.flatMap((r) => collectTextFiles(r)).filter((f) => !f.endsWith('rebrand.test.ts'));
  allFiles.push(join(process.cwd(), 'README.md'));

  for (const pattern of STALE_PATTERNS) {
    it(`no "${pattern}" in source files`, () => {
      const violations: string[] = [];
      for (const f of allFiles) {
        try {
          const content = readFileSync(f, 'utf-8');
          if (pattern.test(content)) {
            violations.push(f.replace(process.cwd(), ''));
          }
        } catch {
          // ignore unreadable files
        }
      }
      expect(violations).toEqual([]);
    });
  }
});
