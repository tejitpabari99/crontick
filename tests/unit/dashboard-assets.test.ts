/** Static dashboard assets: theme icons, Runner Session ID label, log-file link, no inline log, no truncated ids. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (f: string): string => readFileSync(resolve('src/dashboard', f), 'utf-8');
const html = read('index.html');
const js = read('dashboard.js');
const css = read('dashboard.css');

describe('dashboard theme switcher', () => {
  const buttons = [...html.matchAll(/<button[^>]*data-theme-choice="(\w+)"[^>]*>([\s\S]*?)<\/button>/g)];
  it('has three icon-only radio buttons with labels', () => {
    expect(buttons.map((b) => b[1])).toEqual(['system', 'light', 'dark']);
    for (const [full, , inner] of buttons) {
      expect(full).toMatch(/role="radio"/);
      expect(full).toMatch(/aria-checked="(true|false)"/);
      expect(full).toMatch(/aria-label="(System|Light|Dark) theme"/);
      expect(full).toMatch(/title="(System|Light|Dark) theme"/);
      expect(inner).toContain('<svg');
      expect(inner.replace(/<svg[\s\S]*?<\/svg>/g, '').trim()).toBe('');
    }
    expect(html).toContain('role="radiogroup" aria-label="Color theme"');
  });
});

describe('dashboard labels and run modal', () => {
  it('says Runner Session ID and never a bare Session ID label', () => {
    expect(html).toContain('<th>Runner Session ID</th>');
    expect(js).toContain('Runner Session ID:');
    expect(html.replace(/Runner Session ID/g, '')).not.toMatch(/Session ID/);
    expect(js.replace(/Runner Session ID/g, '')).not.toMatch(/Session(:| ID)/);
  });

  it('shows result, error, stderr and the log/transcript paths as plain text with Copy buttons', () => {
    expect(html).not.toContain('<details');
    expect(html).toContain('id="modal-logfile"');
    expect(html).toContain('id="modal-transcript"');
    expect(html).toContain('id="modal-stderr"');
    expect(js).not.toContain('out.output');
    expect(js).toContain('out.result');
    expect(js).not.toContain('log/raw');
    expect(js).not.toContain('rawLogPath');
    expect(js).toContain('file not found');
    expect(js).toContain('data-copy');
    const row = js.slice(js.indexOf('function renderPathRow'), js.indexOf('function closeRunModal'));
    expect(row).not.toContain('<a ');
  });

  it('does not display a total run count', () => {
    expect(js).not.toContain('totalRuns');
    expect(js).not.toMatch(/<span>runs<\/span>/);
  });

  it('uses the Alias term and the full job id', () => {
    expect(js).toContain("kv('Alias'");
    expect(js).toContain("kv('Working directory'");
    expect(js).not.toContain('shortId');
  });
});

describe('dashboard css', () => {
  it('puts row-action icon buttons in one centred inline-flex box', () => {
    const rule = /\.actions-cell \.icon-btn \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('display: inline-flex');
    expect(rule).toContain('align-items: center');
    expect(rule).toContain('vertical-align: middle');
    expect(rule).toMatch(/width: 26px/);
    expect(rule).toMatch(/height: 26px/);
  });
});
