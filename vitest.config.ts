import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

const { version } = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };

/**
 * Vite 5 strips the `node:` prefix from newer built-ins such as `node:sqlite`
 * before its module resolver runs, then fails with "Does the file exist?".
 * This plugin intercepts both `sqlite` and `node:sqlite`, returns a virtual
 * module that re-exports the built-in via `createRequire`; this avoids Vite
 * recursively resolving the virtual module back to itself.
 */
const nodeSqlitePlugin: Plugin = {
  name: 'node-sqlite',
  enforce: 'pre',
  resolveId(id: string) {
    if (id === 'sqlite' || id === 'node:sqlite') {
      return '\0virtual:node-sqlite';
    }
  },
  load(id: string) {
    if (id === '\0virtual:node-sqlite') {
      return [
        "import { createRequire } from 'module';",
        "const _req = createRequire(process.cwd() + '/x.js');",
        "const _mod = _req('node:sqlite');",
        'export const DatabaseSync = _mod.DatabaseSync;',
        'export const StatementSync = _mod.StatementSync;',
      ].join('\n');
    }
  },
};

export default defineConfig({
  plugins: [nodeSqlitePlugin],
  define: {
    __CRONTICK_VERSION__: JSON.stringify(version),
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**'],
  },
});
