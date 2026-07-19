import { readFileSync, cpSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };

export default defineConfig({
  entry: {
    'cli/index': 'src/cli/index.ts',
    'daemon/index': 'src/daemon/index.ts',
    'mcp/index': 'src/mcp/index.ts',
    index: 'src/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  platform: 'node',
  external: ['registry-js'],
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __CRONTICK_VERSION__: JSON.stringify(version),
  },
  async onSuccess() {
    cpSync('src/dashboard', 'dist/dashboard', { recursive: true });
    console.log('  copied: src/dashboard → dist/dashboard');
  },
});
