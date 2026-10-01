/**
 * Vitest global setup: gives every test process an isolated Claude config
 * (`CLAUDE_CONFIG_DIR`) in which the filesystem root is trusted, so jobs created
 * by tests never hit the Claude folder-trust prompt and the real ~/.claude.json
 * is never read or modified. Tests of the trust flow set their own
 * CLAUDE_CONFIG_DIR.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';

export const TEST_CLAUDE_CONFIG_DIR = resolve('.crontick', 'test-claude-config');

export default function setup(): void {
  mkdirSync(TEST_CLAUDE_CONFIG_DIR, { recursive: true });
  const root = parse(process.cwd()).root;
  writeFileSync(
    join(TEST_CLAUDE_CONFIG_DIR, '.claude.json'),
    `${JSON.stringify({ projects: { [root]: { allowedTools: [], hasTrustDialogAccepted: true } } }, null, 2)}\n`,
    'utf-8',
  );
}
