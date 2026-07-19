/**
 * Post-build: rewrite bare `sqlite` module references → `node:sqlite` in dist files.
 * esbuild (used by tsup) normalises newer `node:*` built-ins by stripping the
 * prefix, but Node.js only exposes the `sqlite` built-in via `node:sqlite`.
 *
 * Handles: from "sqlite", from 'sqlite', import("sqlite"), import('sqlite'),
 *          require("sqlite"), require('sqlite')
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';

// Matches: from "sqlite", from 'sqlite', import("sqlite"), import('sqlite'),
//          require("sqlite"), require('sqlite')
// Capture group 1: the keyword/paren prefix
// Capture group 2: the quote character (for backreference \2)
const SQLITE_RE = /(from\s+|import\(|require\()(['"])sqlite\2/g;

function patchFile(fullPath) {
  const src = readFileSync(fullPath, 'utf-8');
  const fixed = src.replace(SQLITE_RE, (_, prefix, quote) => `${prefix}${quote}node:sqlite${quote}`);
  if (fixed !== src) {
    writeFileSync(fullPath, fixed);
    console.log(`  patched: ${fullPath}`);
  }
}

function processDir(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      processDir(fullPath);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.cjs')) {
      patchFile(fullPath);
    }
  }
}

processDir(DIST);
