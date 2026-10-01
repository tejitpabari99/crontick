/**
 * Vitest global setup: gives every test process an isolated Claude config
 * (`CLAUDE_CONFIG_DIR`) in which the filesystem root(s) are trusted, so jobs created
 * by tests never hit the Claude folder-trust prompt and the real ~/.claude.json
 * is never read or modified. Tests of the trust flow set their own
 * CLAUDE_CONFIG_DIR.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';

export const TEST_CLAUDE_CONFIG_DIR = resolve('.crontick', 'test-claude-config');

export default function setup(): void {
  mkdirSync(TEST_CLAUDE_CONFIG_DIR, { recursive: true });
  // On Windows the repo and the temp dir can live on different drives, each with its own root.
  const roots = [...new Set([process.cwd(), tmpdir()].map((path) => parse(path).root))];
  writeFileSync(
    join(TEST_CLAUDE_CONFIG_DIR, '.claude.json'),
    `${JSON.stringify({ projects: Object.fromEntries(roots.map((root) => [root, { allowedTools: [], hasTrustDialogAccepted: true }])) }, null, 2)}\n`,
    'utf-8',
  );
}
