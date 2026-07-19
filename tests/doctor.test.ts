/**
 * `crontick doctor` smoke test.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CLI_SCRIPT = resolve('dist/cli/index.js');

describe('crontick doctor', () => {
  it('runs and reports checks (even if some fail)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crontick-doctor-'));
    mkdirSync(join(dir, 'jobs'), { recursive: true });

    const result = spawnSync(process.execPath, [CLI_SCRIPT, 'doctor'], {
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, CRONTICK_HOME: dir },
    });

    try {
      const output = result.stdout + result.stderr;
      expect(output).toMatch(/[✓✗]/);
      expect(output).toMatch(/Node\.js/);
      expect(output).toMatch(/sqlite/i);
      expect(result.status !== null).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
