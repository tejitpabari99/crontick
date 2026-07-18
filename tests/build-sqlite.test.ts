/**
 * Post-build check: no bare `sqlite` references remain in dist/ files.
 * Verifies that scripts/fix-node-sqlite.mjs ran correctly.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function collectJsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectJsFiles(full));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.cjs')) files.push(full);
  }
  return files;
}

const BARE_SQLITE_RE = /(from\s+|import\(|require\()(['"])sqlite\2/;

describe('dist/ has no bare sqlite references', () => {
  const distRoot = join(process.cwd(), 'dist');
  const distFiles = existsSync(distRoot) ? collectJsFiles(distRoot) : [];

  it('dist/ should contain at least some JS files', () => {
    expect(distFiles.length).toBeGreaterThan(0);
  });

  for (const f of distFiles) {
    it(`${f.replace(process.cwd(), '')} has no bare sqlite refs`, () => {
      const content = readFileSync(f, 'utf-8');
      expect(BARE_SQLITE_RE.test(content)).toBe(false);
    });
  }
});
