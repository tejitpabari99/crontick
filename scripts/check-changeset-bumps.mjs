#!/usr/bin/env node
/**
 * Release guard: fail if any pending changeset declares a `major` bump.
 *
 * While crontick is on a 0.x version, a `major` changeset would jump straight
 * to 1.0.0 -- almost never what's intended by accident. This script scans
 * `.changeset/*.md` (ignoring `README.md` and `config.json`), parses each
 * file's YAML-ish frontmatter (`"pkg": patch|minor|major|none` lines between
 * a pair of `---` fences), and fails (exit 1) listing the offending files if
 * any declares a bump above the allowed ceiling.
 *
 * Ceiling rules:
 *   - Default ceiling is `minor` (patch/minor pass, major is blocked).
 *   - `ALLOW_MAJOR=true` raises the ceiling to `major` for this run.
 *   - `MAX_BUMP=patch|minor|major` sets an explicit ceiling and takes
 *     precedence over ALLOW_MAJOR (an explicit, stricter config wins).
 *
 * Usage:
 *   node scripts/check-changeset-bumps.mjs [changesetDir]
 *   CHANGESET_DIR=<path> node scripts/check-changeset-bumps.mjs
 *
 * `changesetDir` defaults to `.changeset` relative to the current working
 * directory. The directory argument / env var exist mainly so tests can
 * point this script at a temp fixture directory.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BUMP_RANK = { none: 0, patch: 1, minor: 2, major: 3 };

/**
 * Parse a changeset markdown file's frontmatter into a list of
 * `{ pkg, bump }` entries. Returns `[]` if the file has no recognizable
 * frontmatter (e.g. malformed, or the empty-changeset template).
 */
export function parseChangesetFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return [];

  const entries = [];
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const match = line.match(/^\s*["']?([^"':]+)["']?\s*:\s*(none|patch|minor|major)\s*$/);
    if (match) entries.push({ pkg: match[1].trim(), bump: match[2].trim() });
  }
  return entries;
}

/** Highest bump rank declared across a changeset's frontmatter entries. */
export function highestBump(entries) {
  let highest = 'none';
  for (const { bump } of entries) {
    if (BUMP_RANK[bump] > BUMP_RANK[highest]) highest = bump;
  }
  return highest;
}

/** List `.md` changeset files in `dir`, excluding README.md. */
export function listChangesetFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md')
    .sort();
}

/**
 * Check all changesets in `dir` against the ceiling derived from
 * `env.ALLOW_MAJOR` / `env.MAX_BUMP`. Returns `{ ok, ceiling, offending }`
 * where `offending` is a list of `{ file, bump }` for files above ceiling.
 */
export function checkChangesetBumps(dir, env = process.env) {
  const allowMajor = env.ALLOW_MAJOR === 'true';
  const maxBumpEnv = env.MAX_BUMP;

  if (maxBumpEnv && !(maxBumpEnv in BUMP_RANK)) {
    throw new Error(`Invalid MAX_BUMP value "${maxBumpEnv}" (expected patch, minor, or major)`);
  }

  const ceiling = maxBumpEnv ?? (allowMajor ? 'major' : 'minor');
  const ceilingRank = BUMP_RANK[ceiling];

  const files = listChangesetFiles(dir);
  const offending = [];

  for (const file of files) {
    const content = readFileSync(join(dir, file), 'utf-8');
    const bump = highestBump(parseChangesetFrontmatter(content));
    if (BUMP_RANK[bump] > ceilingRank) offending.push({ file, bump });
  }

  return { ok: offending.length === 0, ceiling, files, offending };
}

function main() {
  const dir = process.argv[2] ?? process.env.CHANGESET_DIR ?? '.changeset';
  let result;
  try {
    result = checkChangesetBumps(dir, process.env);
  } catch (err) {
    console.error(`[check-changeset-bumps] FAIL: ${err.message}`);
    process.exit(1);
  }

  if (!result.ok) {
    console.error(
      `[check-changeset-bumps] FAIL: pending changeset(s) exceed the allowed bump ceiling ` +
        `("${result.ceiling}"):`,
    );
    for (const { file, bump } of result.offending) {
      console.error(`  - ${file} declares "${bump}"`);
    }
    console.error(
      '\nWhile crontick is on a 0.x version, a "major" changeset jumps straight to 1.0.0.\n' +
        'If this is intentional, re-run with ALLOW_MAJOR=true (the manual release workflow\n' +
        'exposes this as the "allow_major" input), or edit the changeset\'s frontmatter to a\n' +
        'lower bump if it was a mistake.',
    );
    process.exit(1);
  }

  console.log(
    `[check-changeset-bumps] OK: ${result.files.length} changeset(s) checked, none exceed "${result.ceiling}"`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
