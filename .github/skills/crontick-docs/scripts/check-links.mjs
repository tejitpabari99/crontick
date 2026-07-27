#!/usr/bin/env node

/**
 * check-links.mjs
 *
 * Verifies that every relative markdown link in the documentation tree resolves
 * to an existing file. Exits non-zero and prints offenders when a link is broken.
 *
 * Usage: node .github/skills/crontick-docs/scripts/check-links.mjs
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..', '..', '..');

// Directories to scan for markdown files
const SCAN_DIRS = ['docs', 'specs', 'examples', '.github'];
const ROOT_FILES = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'SECURITY.md'];

// Regex to match markdown links: [text](path) -- excludes URLs and anchors-only
const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

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
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      results.push(full);
    }
  }
  return results;
}

function isRelativeLink(href) {
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) return false;
  if (href.startsWith('#')) return false;
  return true;
}

function stripAnchor(href) {
  const idx = href.indexOf('#');
  return idx >= 0 ? href.substring(0, idx) : href;
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const mdFiles = [];

  // Collect root-level markdown files
  for (const f of ROOT_FILES) {
    const full = join(repoRoot, f);
    if (await fileExists(full)) {
      mdFiles.push(full);
    }
  }

  // Collect markdown files from scan directories
  for (const dir of SCAN_DIRS) {
    const full = join(repoRoot, dir);
    mdFiles.push(...await findMarkdownFiles(full));
  }

  const broken = [];

  for (const mdFile of mdFiles) {
    const content = await readFile(mdFile, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let match;
      LINK_RE.lastIndex = 0;
      while ((match = LINK_RE.exec(line)) !== null) {
        const href = match[2].trim();
        if (!isRelativeLink(href)) continue;

        const pathPart = stripAnchor(href);
        if (!pathPart) continue; // anchor-only after strip

        const target = resolve(dirname(mdFile), pathPart);

        if (!await fileExists(target)) {
          const relSource = mdFile.substring(repoRoot.length + 1).replace(/\\/g, '/');
          broken.push({
            source: relSource,
            line: i + 1,
            href: href,
            resolved: target.substring(repoRoot.length + 1).replace(/\\/g, '/')
          });
        }
      }
    }
  }

  if (broken.length === 0) {
    console.log(`Checked ${mdFiles.length} markdown files. All relative links resolve.`);
    process.exit(0);
  } else {
    console.error(`Found ${broken.length} broken link(s) in ${mdFiles.length} files:\n`);
    for (const b of broken) {
      console.error(`  ${b.source}:${b.line} -> ${b.href}`);
      console.error(`    resolves to: ${b.resolved} (not found)`);
    }
    process.exit(1);
  }
}

main();
