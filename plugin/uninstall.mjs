#!/usr/bin/env node
/**
 * crontick Copilot marketplace plugin — uninstall script.
 *
 * Steps:
 *   1. Remove ~/.copilot/skills/crontick/SKILL.md (always).
 *   2. Optionally remove win32 autostart (if CRONTICK_PLUGIN_UNINSTALL_AUTOSTART=1).
 *   3. Data directory is preserved by default — hint at `crontick uninstall --purge`.
 *
 * Environment flags:
 *   CRONTICK_PLUGIN_UNINSTALL_AUTOSTART=1   — also remove autostart entry
 */

import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const removeAutostart = process.env['CRONTICK_PLUGIN_UNINSTALL_AUTOSTART'] === '1';

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

// ── Step 2: Optional autostart removal ───────────────────────────────────────

if (removeAutostart) {
  console.log('[crontick-plugin] Removing autostart…');
  const result = spawnSync('crontick', ['autostart', 'remove'], {
    stdio: 'inherit',
    timeout: 10_000,
  });
  if ((result.status ?? 1) === 0) {
    steps.push('autostart entry removed');
  } else {
    steps.push('autostart removal FAILED (see above)');
  }
} else {
  steps.push('autostart preserved (set CRONTICK_PLUGIN_UNINSTALL_AUTOSTART=1 to remove)');
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
