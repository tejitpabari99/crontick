/**
 * Plugin install script tests.
 * Runs plugin/install.mjs in a subprocess with:
 *   - CRONTICK_PLUGIN_NONINTERACTIVE=1
 *   - CRONTICK_PLUGIN_SKIP_NPM=1  (avoid real npm install)
 *   - CRONTICK_PLUGIN_SKIP_AUTOSTART=1  (avoid win32 registry changes)
 *   - USERPROFILE / HOME pointing to a temp directory
 *
 * Verifies that SKILL.md is copied to <tmpHome>/.copilot/skills/crontick/SKILL.md
 * and matches the bundled src/skill/SKILL.md.
 */
import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const INSTALL_SCRIPT = resolve('plugin/install.mjs');
const SKILL_MD_SRC = resolve('src/skill/SKILL.md');

describe('plugin/install.mjs', () => {
  it('copies SKILL.md to <home>/.copilot/skills/crontick/', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'crontick-plugin-'));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        USERPROFILE: tmpHome,
        HOME: tmpHome,
        CRONTICK_PLUGIN_NONINTERACTIVE: '1',
        CRONTICK_PLUGIN_SKIP_NPM: '1',
        CRONTICK_PLUGIN_SKIP_AUTOSTART: '1',
      };

      const result = spawnSync(process.execPath, [INSTALL_SCRIPT], {
        env,
        encoding: 'utf-8',
        timeout: 30_000,
      });

      // Script should exit 0
      expect(result.status, `install.mjs stderr: ${result.stderr}`).toBe(0);

      // SKILL.md should be present
      const skillDst = join(tmpHome, '.copilot', 'skills', 'crontick', 'SKILL.md');
      expect(existsSync(skillDst)).toBe(true);

      // Content should match the bundled source
      const srcContent = readFileSync(SKILL_MD_SRC, 'utf-8');
      const dstContent = readFileSync(skillDst, 'utf-8');
      expect(dstContent).toBe(srcContent);
    } finally {
      try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('prints summary of completed steps', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'crontick-plugin-'));
    try {
      const result = spawnSync(process.execPath, [INSTALL_SCRIPT], {
        env: {
          ...process.env,
          USERPROFILE: tmpHome,
          HOME: tmpHome,
          CRONTICK_PLUGIN_NONINTERACTIVE: '1',
          CRONTICK_PLUGIN_SKIP_NPM: '1',
          CRONTICK_PLUGIN_SKIP_AUTOSTART: '1',
        },
        encoding: 'utf-8',
        timeout: 30_000,
      });
      expect(result.stdout).toContain('SKILL.md copied to');
      expect(result.stdout).toContain('Installation complete');
    } finally {
      try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
