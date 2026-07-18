#!/usr/bin/env node
/**
 * crontick Copilot marketplace plugin — install script.
 *
 * Steps:
 *   1. Check/install the crontick npm package globally.
 *   2. Run `crontick doctor` to verify the installation.
 *   3. Copy the bundled SKILL.md to ~/.copilot/skills/crontick/.
 *   4. Optionally install win32 autostart (skipped in non-interactive mode or non-win32).
 *
 * Environment flags:
 *   CRONTICK_PLUGIN_NONINTERACTIVE=1   — skip prompts, accept defaults
 *   CRONTICK_PLUGIN_SKIP_NPM=1         — skip `npm i -g crontick` step (for testing)
 *   CRONTICK_PLUGIN_SKIP_AUTOSTART=1   — skip autostart installation
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const nonInteractive = process.env['CRONTICK_PLUGIN_NONINTERACTIVE'] === '1';
const skipNpm = process.env['CRONTICK_PLUGIN_SKIP_NPM'] === '1';
const skipAutostart = process.env['CRONTICK_PLUGIN_SKIP_AUTOSTART'] === '1';

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    encoding: 'utf-8',
    timeout: 120_000,
    ...opts,
  });
  return result.status ?? 1;
}

function runCapture(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf-8',
    timeout: 10_000,
    windowsHide: true,
    ...opts,
  });
}

function binaryExists(name) {
  const which = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = runCapture(which, [name]);
  return result.status === 0 && result.stdout.trim().length > 0;
}

async function prompt(question) {
  if (nonInteractive) return '';
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Step 1: Ensure crontick is installed ─────────────────────────────────────

const steps = [];

if (!skipNpm) {
  if (!binaryExists('crontick')) {
    console.log('\n[crontick-plugin] crontick not found on PATH — installing globally…');
    const exitCode = run('npm', ['install', '-g', 'crontick']);
    if (exitCode !== 0) {
      console.error('[crontick-plugin] npm install failed. Try: npm install -g crontick');
      process.exit(1);
    }
    steps.push('Installed crontick globally via npm');
    console.log('[crontick-plugin] crontick installed.');
  } else {
    console.log('[crontick-plugin] crontick already installed — skipping npm install.');
    steps.push('crontick already installed');
  }
} else {
  steps.push('npm install skipped (CRONTICK_PLUGIN_SKIP_NPM=1)');
}

// ── Step 2: Run crontick doctor ───────────────────────────────────────────────

console.log('\n[crontick-plugin] Running crontick doctor…');
run('crontick', ['doctor']);
steps.push('crontick doctor completed');

// ── Step 3: Copy SKILL.md ─────────────────────────────────────────────────────

// Locate the bundled SKILL.md relative to this script file
// This script is at <pkg>/plugin/install.mjs
// SKILL.md is at <pkg>/src/skill/SKILL.md
const skillSrc = join(__dirname, '..', 'src', 'skill', 'SKILL.md');

if (!existsSync(skillSrc)) {
  console.warn(`[crontick-plugin] Warning: SKILL.md not found at ${skillSrc}`);
  steps.push('SKILL.md copy SKIPPED (source not found)');
} else {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? homedir();
  const skillsDir = join(home, '.copilot', 'skills', 'crontick');
  mkdirSync(skillsDir, { recursive: true });
  const skillDst = join(skillsDir, 'SKILL.md');
  copyFileSync(skillSrc, skillDst);
  steps.push(`SKILL.md copied to ${skillDst}`);
  console.log(`[crontick-plugin] SKILL.md installed at: ${skillDst}`);
}

// ── Step 4: Optional autostart ────────────────────────────────────────────────

if (!skipAutostart) {
  if (process.platform === 'win32') {
    let doAutostart = nonInteractive;
    if (!nonInteractive) {
      const answer = await prompt(
        '\n[crontick-plugin] Install autostart? Registers crontick-daemon to start at login. [Y/n] ',
      );
      doAutostart = answer === '' || answer.toLowerCase() === 'y';
    }
    if (doAutostart) {
      console.log('[crontick-plugin] Installing autostart…');
      const code = run('crontick', ['autostart', 'install']);
      if (code === 0) {
        steps.push('win32 autostart installed');
        console.log('[crontick-plugin] Autostart installed.');
      } else {
        steps.push('autostart install FAILED (see above)');
        console.warn('[crontick-plugin] Autostart install failed — you can retry later: crontick autostart install');
      }
    } else {
      steps.push('autostart skipped by user');
      console.log('[crontick-plugin] Autostart skipped. Run later: crontick autostart install');
    }
  } else {
    console.log('[crontick-plugin] Autostart (non-Windows): run `crontick autostart status` for manual setup instructions.');
    steps.push('autostart not applicable on this platform (non-win32)');
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n[crontick-plugin] Installation complete!\n');
for (const step of steps) {
  console.log(`  ✓ ${step}`);
}
console.log('\nGet started:');
console.log('  crontick --help');
console.log('  crontick daemon start');
console.log('  crontick new my-job --cron "0 9 * * *" --script "echo hello"');
