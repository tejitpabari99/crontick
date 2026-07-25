#!/usr/bin/env node
/**
 * crontick Copilot marketplace plugin — uninstall script.
 *
 * Steps:
 *   1. Remove ~/.copilot/skills/crontick/SKILL.md (always). *   3. Data directory is preserved by default — hint at `crontick uninstall --purge`.
 *
 */

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';


const steps = [];

// ── Step 1: Remove SKILL.md ───────────────────────────────────────────────────

const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? homedir();
const skillDst = join(home, '.copilot', 'skills', 'crontick', 'SKILL.md');

if (existsSync(skillDst)) {
  try {
    unlinkSync(skillDst);
    steps.push(`SKILL.md removed from ${skillDst}`);
    console.log(`[crontick-plugin] Removed SKILL.md: ${skillDst}`);
  } catch (err) {
    console.warn(`[crontick-plugin] Could not remove SKILL.md: ${err.message}`);
    steps.push('SKILL.md removal FAILED');
  }
} else {
  steps.push('SKILL.md not found (already removed)');
  console.log('[crontick-plugin] SKILL.md not found — already removed.');
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n[crontick-plugin] Uninstall complete!\n');
for (const step of steps) {
  console.log(`  ✓ ${step}`);
}
console.log(
  '\nData directory preserved. To delete ALL crontick data, run:\n' +
  '  crontick uninstall --purge\n',
);
