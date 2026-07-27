#!/usr/bin/env node
/**
 * Guard for `typecheck:examples:dist`: TypeScript's own error when the paths
 * mapping target is missing is a confusing `TS2209 "project root is
 * ambiguous"` message (it falls back to package self-name/exports
 * resolution). Fail fast with an actionable message instead.
 */
import { existsSync } from 'node:fs';

if (!existsSync('dist/index.d.ts')) {
  console.error(
    '\ndist/index.d.ts not found.\n' +
      '`typecheck:examples:dist` validates examples against the PUBLISHED declaration\n' +
      'output, not source. Run `npm run build` first, then re-run this command.\n',
  );
  process.exit(1);
}
