#!/usr/bin/env node

/**
 * doc-inventory.mjs
 *
 * Lists the documentation tree and flags files that exist on disk but are not
 * indexed in docs/README.md. Also flags entries in docs/README.md that point to
 * non-existent files.
 *
 * Usage: node .github/skills/crontick-docs/scripts/doc-inventory.mjs
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname, resolve, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..', '..', '..');

const DOCS_README = join(repoRoot, 'docs', 'README.md');

// Directories that docs/README.md should index
const INDEXED_DIRS = [
  { dir: 'docs', prefix: '' },
  { dir: 'specs', prefix: '../specs/' },
  { dir: 'examples', prefix: '../examples/' },
];

async function findMarkdownFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      results.push(...await findMarkdownFiles(full));
    } else if (entry.isFile() && (extname(entry.name) === '.md' || extname(entry.name) === '.ts')) {
      results.push(full);
    }
  }
  return results;
}

function extractLinkedPaths(content, baseDir) {
  const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
  const paths = new Set();
  let match;
  while ((match = LINK_RE.exec(content)) !== null) {
    const href = match[2].trim();
    if (href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#')) continue;
    const pathPart = href.includes('#') ? href.substring(0, href.indexOf('#')) : href;
    if (!pathPart) continue;
    const resolved = resolve(baseDir, pathPart);
    const rel = relative(repoRoot, resolved).replace(/\\/g, '/');
    paths.add(rel);
  }
  return paths;
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(filePath) {
  try {
    const s = await stat(filePath);
    return s.isFile() || s.isDirectory();
  } catch {
    return false;
  }
}

async function main() {
  // Read docs/README.md and extract all linked paths
  let readmeContent;
  try {
    readmeContent = await readFile(DOCS_README, 'utf-8');
  } catch {
    console.error('ERROR: docs/README.md not found');
    process.exit(1);
  }

  const docsDir = join(repoRoot, 'docs');
  const indexedPaths = extractLinkedPaths(readmeContent, docsDir);

  // Find all actual doc files on disk
  const diskFiles = new Set();

  for (const { dir } of INDEXED_DIRS) {
    const fullDir = join(repoRoot, dir);
    const files = await findMarkdownFiles(fullDir);
    for (const f of files) {
      const rel = relative(repoRoot, f).replace(/\\/g, '/');
      diskFiles.add(rel);
    }
  }

  // Also check root-level doc files
  for (const f of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
    if (await fileExists(join(repoRoot, f))) {
      diskFiles.add(f);
    }
  }

  // Find unindexed files (on disk but not in docs/README.md)
  const unindexed = [];
  for (const diskFile of diskFiles) {
    if (!indexedPaths.has(diskFile)) {
      // Skip files that are not expected to be in docs/README.md index
      // (root-level files, tsconfig, etc.)
      if (!diskFile.startsWith('docs/') && !diskFile.startsWith('specs/') && !diskFile.startsWith('examples/')) continue;
      // Skip the README itself
      if (diskFile === 'docs/README.md') continue;
      // Skip tsconfig files in examples
      if (diskFile.endsWith('tsconfig.json')) continue;
      // Skip ADR numbered files (0001+) -- docs/README.md delegates to decisions/README.md
      if (/^docs\/decisions\/\d{4}-.+\.md$/.test(diskFile) && diskFile !== 'docs/decisions/0000-template.md') continue;
      unindexed.push(diskFile);
    }
  }

  // Find phantom entries (in docs/README.md but not on disk)
  const phantoms = [];
  for (const indexed of indexedPaths) {
    if (indexed.startsWith('docs/') || indexed.startsWith('specs/') || indexed.startsWith('examples/')) {
      if (!diskFiles.has(indexed)) {
        // Check if it is a directory link (e.g. docs/concepts/ linked as concepts/)
        const fullPath = join(repoRoot, indexed);
        if (!await pathExists(fullPath)) {
          phantoms.push(indexed);
        }
      }
    }
  }

  // Print inventory
  console.log('=== Documentation inventory ===\n');
  console.log(`Files on disk: ${diskFiles.size}`);
  console.log(`Paths indexed in docs/README.md: ${indexedPaths.size}`);
  console.log('');

  if (unindexed.length > 0) {
    console.log(`WARNING: ${unindexed.length} file(s) exist on disk but are NOT indexed in docs/README.md:\n`);
    for (const f of unindexed.sort()) {
      console.log(`  + ${f}`);
    }
    console.log('');
  }

  if (phantoms.length > 0) {
    console.log(`WARNING: ${phantoms.length} path(s) indexed in docs/README.md do NOT exist on disk:\n`);
    for (const f of phantoms.sort()) {
      console.log(`  - ${f}`);
    }
    console.log('');
  }

  if (unindexed.length === 0 && phantoms.length === 0) {
    console.log('All doc files are indexed and all index entries resolve. No issues found.');
  }

  // Exit non-zero only if there are phantoms (broken index entries)
  if (phantoms.length > 0) {
    process.exit(1);
  }
}

main();
