import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('vitest globalSetup Windows safety', () => {
  it('modules imported by tmp-isolation have no shebang (breaks vite-node on CRLF checkouts)', () => {
    const setup = readFileSync('tests/helpers/tmp-isolation.ts', 'utf-8');
    const imports = [...setup.matchAll(/from '(\.\.\/\.\.\/scripts\/[^']+)'/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const rel of imports) {
      const src = readFileSync(rel.replace('../../', ''), 'utf-8');
      expect(src.startsWith('#!'), rel).toBe(false);
    }
  });

  it('.gitattributes forces LF', () => {
    expect(readFileSync('.gitattributes', 'utf-8')).toMatch(/eol=lf/);
  });
});
