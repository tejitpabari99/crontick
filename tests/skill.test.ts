/**
 * SKILL.md content and package inclusion tests.
 *
 * Verifies:
 *   1. src/skill/SKILL.md contains the required sections.
 *   2. The `files` allowlist in package.json includes src/skill/SKILL.md.
 *   3. The errResult redactor removes absolute paths before reaching the LLM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { redactForLlm } from '../src/mcp/index.js';

const SKILL_MD = resolve('src/skill/SKILL.md');
const PKG_JSON = resolve('package.json');

// ── SKILL.md content ──────────────────────────────────────────────────────────

describe('src/skill/SKILL.md content', () => {
  const content = readFileSync(SKILL_MD, 'utf-8');

  it('has a title and purpose section', () => {
    expect(content).toMatch(/crontick.*skill/i);
    expect(content).toMatch(/purpose|when to use/i);
  });

  it('contains workflow steps', () => {
    expect(content).toMatch(/step 1/i);
    expect(content).toMatch(/step 2/i);
    expect(content).toMatch(/step 3/i);
    expect(content).toMatch(/step 4/i);
  });

  it('lists crontick_* tools', () => {
    expect(content).toContain('crontick_job_create');
    expect(content).toContain('crontick_job_list');
    expect(content).toContain('crontick_schedule_validate');
    expect(content).toContain('crontick_schedule_preview');
    expect(content).toContain('crontick_autostart_install');
  });

  it('contains ban statements (no LLM sub-runtime)', () => {
    expect(content).toMatch(/never invent.*llm|do not.*llm-prompt|llm sub-runtime/i);
  });

  it('contains confirmation guardrail for delete/disable', () => {
    expect(content).toMatch(/confirm.*delete|delete.*confirm/i);
  });

  it('contains at least one worked example', () => {
    expect(content).toMatch(/example/i);
    // Should have a daily or weekly example
    expect(content).toMatch(/daily|weekly/i);
  });

  it('references crontick://schemas/job resource', () => {
    expect(content).toContain('crontick://schemas/job');
  });

  it('mentions set -euo pipefail and ErrorActionPreference', () => {
    expect(content).toContain('set -euo pipefail');
    expect(content).toContain('ErrorActionPreference');
  });

  it('is between 150 and 350 lines', () => {
    const lines = content.split('\n').length;
    expect(lines).toBeGreaterThanOrEqual(150);
    expect(lines).toBeLessThanOrEqual(350);
  });
});

// ── package.json files allowlist ──────────────────────────────────────────────

describe('package.json files allowlist', () => {
  it('includes src/skill/SKILL.md', () => {
    const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf-8')) as { files: string[] };
    expect(pkg.files).toContain('src/skill/SKILL.md');
  });
});

// ── errResult redaction ───────────────────────────────────────────────────────

describe('redactForLlm', () => {
  it('redacts Windows absolute paths', () => {
    const msg = 'Daemon script not found at C:\\Users\\x\\dist\\daemon\\index.js. Run: npm run build';
    const redacted = redactForLlm(msg);
    expect(redacted).not.toContain('C:\\Users\\x');
    expect(redacted).toContain('<path>');
    expect(redacted).toContain('Run: npm run build');
  });

  it('redacts POSIX absolute paths', () => {
    const msg = 'Error loading /usr/local/lib/node_modules/crontick/dist/daemon/index.js';
    const redacted = redactForLlm(msg);
    expect(redacted).not.toContain('/usr/local/lib');
    expect(redacted).toContain('<path>');
  });

  it('redacts loopback address:port', () => {
    const msg = 'Connection refused at 127.0.0.1:54321';
    const redacted = redactForLlm(msg);
    expect(redacted).not.toContain('54321');
    expect(redacted).toContain('<daemon-addr>');
  });

  it('leaves normal text untouched', () => {
    const msg = 'Job not found: my-job';
    expect(redactForLlm(msg)).toBe('Job not found: my-job');
  });

  it('redacts C:\\Users\\x\\dist\\daemon\\index.js specifically', () => {
    const msg = `Daemon script not found at C:\\Users\\x\\dist\\daemon\\index.js`;
    const redacted = redactForLlm(msg);
    expect(redacted).not.toContain('C:\\Users\\x\\dist\\daemon\\index.js');
    expect(redacted).toContain('<path>');
  });
});
