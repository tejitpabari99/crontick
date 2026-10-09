/** Dashboard Settings modal + paused state (SP03 Task 8): string/HTTP assertions plus the pure diff helpers. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startApiHarness, type ApiHarness } from '../helpers/api-harness.js';

const read = (f: string): string => readFileSync(resolve('src/dashboard', f), 'utf-8');
const html = read('index.html');
const js = read('dashboard.js');
const css = read('dashboard.css');

interface Op { op: 'set' | 'unset'; key: string; value?: unknown }
interface Pure {
  buildSettingsOps(base: unknown, draft: unknown): Op[];
  parseNumberField(text: string, optional: boolean): unknown;
  matchFieldKeys(errorKey: string, fields: string[]): string[];
}
function loadPure(): Pure {
  const m = /\/\/ <settings-pure>([\s\S]*?)\/\/ <\/settings-pure>/.exec(js);
  expect(m, 'settings-pure block').not.toBeNull();
  return new Function(`${m![1]}; return { buildSettingsOps, parseNumberField, matchFieldKeys };`)() as Pure;
}

interface Cfg {
  defaultEngine: string;
  maxConsecutiveFailures: number;
  defaults: { overlap: string; timeoutSec?: number; retry: { max: number; backoffSec: number } };
  retention: Record<string, number>;
  logging: { fileEnabled: boolean; dir?: string };
  daemon: { port: number };
  engines: Record<string, { command: string; args: string[]; env: Record<string, string>; type: string }>;
}
const base = (): Cfg => ({
  defaultEngine: 'claude',
  maxConsecutiveFailures: 5,
  defaults: { overlap: 'skip', retry: { max: 0, backoffSec: 30 } },
  retention: { maxRunsPerJob: 100, maxOutputBytesPerRun: 2048, maxLogFiles: 30 },
  logging: { fileEnabled: true },
  daemon: { port: 7777 },
  engines: {
    claude: { command: 'claude', args: ['-p'], env: { TOKEN: '[REDACTED]', A: '1' }, type: 'claude' },
    other: { command: 'x', args: [], env: {}, type: 'raw' },
  },
});

describe('buildSettingsOps (changed leaves only)', () => {
  const p = loadPure();
  it('zero diff produces no ops (echoed redacted values are unchanged)', () => {
    expect(p.buildSettingsOps(base(), base())).toEqual([]);
  });
  it('sends only changed scalar leaves', () => {
    const d = base();
    d.maxConsecutiveFailures = 9;
    d.defaults.retry.max = 2;
    expect(p.buildSettingsOps(base(), d)).toEqual([
      { op: 'set', key: 'maxConsecutiveFailures', value: 9 },
      { op: 'set', key: 'defaults.retry.max', value: 2 },
    ]);
  });
  it('optional leaves: set when filled, unset when cleared', () => {
    const d = base() ;
    d.defaults.timeoutSec = 60;
    d.logging.dir = '/tmp/x';
    expect(p.buildSettingsOps(base(), d)).toEqual([
      { op: 'set', key: 'defaults.timeoutSec', value: 60 },
      { op: 'set', key: 'logging.dir', value: '/tmp/x' },
    ]);
    const b = base() ;
    b.logging.dir = '/a';
    const d2 = base() ;
    d2.logging.dir = undefined;
    expect(p.buildSettingsOps(b, d2)).toEqual([{ op: 'unset', key: 'logging.dir' }]);
  });
  it('never emits daemon.* ops', () => {
    const d = base();
    d.daemon.port = 1;
    expect(p.buildSettingsOps(base(), d)).toEqual([]);
  });
  it('engine leaves: command/type/args/env per key, redacted env untouched', () => {
    const d = base();
    d.engines.claude.command = 'claude2';
    d.engines.claude.args = ['-p', '--x'];
    d.engines.claude.env = { TOKEN: '[REDACTED]', B: '2' };
    expect(p.buildSettingsOps(base(), d)).toEqual([
      { op: 'set', key: 'engines.claude.command', value: 'claude2' },
      { op: 'set', key: 'engines.claude.args', value: ['-p', '--x'] },
      { op: 'set', key: 'engines.claude.env.B', value: '2' },
      { op: 'unset', key: 'engines.claude.env.A' },
    ]);
  });
  it('engine add sets the whole engine; remove unsets it; removals come last', () => {
    const d = base() ;
    delete d.engines.other;
    d.engines.fresh = { command: 'f', args: [], env: {}, type: 'raw' };
    d.defaultEngine = 'fresh';
    expect(p.buildSettingsOps(base(), d)).toEqual([
      { op: 'set', key: 'engines.fresh', value: { command: 'f', args: [], env: {}, type: 'raw' } },
      { op: 'set', key: 'defaultEngine', value: 'fresh' },
      { op: 'unset', key: 'engines.other' },
    ]);
  });
});

describe('field helpers', () => {
  const p = loadPure();
  it('parseNumberField', () => {
    expect(p.parseNumberField('12', false)).toBe(12);
    expect(p.parseNumberField(' 1.5 ', true)).toBe(1.5);
    expect(p.parseNumberField('', true)).toBeUndefined();
    expect(p.parseNumberField('', false)).toBe('');
    expect(p.parseNumberField('abc', false)).toBe('abc');
  });
  it('matchFieldKeys maps an error key to inputs (exact, else related by path)', () => {
    const fields = ['retention.maxLogFiles', 'engines.claude.command', 'engines.claude.env.A', 'engines.claude.args', 'engines.claude.args'];
    expect(p.matchFieldKeys('retention.maxLogFiles', fields)).toEqual(['retention.maxLogFiles']);
    expect(p.matchFieldKeys('engines.claude.args.0', fields)).toEqual(['engines.claude.args', 'engines.claude.args']);
    expect(p.matchFieldKeys('nope', fields)).toEqual([]);
  });
});

describe('settings modal markup + behavior wiring', () => {
  it('has a gear button after the theme toggle and a modal reusing .modal-backdrop', () => {
    expect(html).toMatch(/id="btn-settings"[^>]*aria-label="Settings"/);
    expect(html.indexOf('id="theme-toggle"')).toBeLessThan(html.indexOf('id="btn-settings"'));
    expect(html).toMatch(/<div id="settings-modal" class="modal-backdrop" hidden>/);
    for (const id of ['settings-edit', 'settings-save', 'settings-cancel', 'settings-close', 'settings-banner', 'settings-form']) {
      expect(html).toContain(`id="${id}"`);
    }
  });
  it('wires the owner-specified dirty confirmation and Save/Edit state', () => {
    expect(js).toContain("'Discard unsaved changes? Changes will be lost.'");
    expect(js).toContain('window.confirm(DISCARD_MESSAGE)');
    expect(js).toContain('Reload form');
    expect(js).toContain('Config changed on disk');
    expect(js).toContain('ifRevision');
    expect(js).toContain("method: 'PATCH'");
    expect(js).toMatch(/inFlight: choice|inFlight: /);
    expect(js).toContain('/api/config');
    expect(js).toContain('settingsSave.disabled = !settingsEditing');
  });
  it('mutating fetches send Content-Type: application/json', () => {
    const body = js.slice(js.indexOf('// ── Settings modal'));
    for (const m of body.matchAll(/method: '(PATCH|POST)'/g)) {
      const around = body.slice(m.index!, m.index! + 160);
      expect(around).toContain("'Content-Type': 'application/json'");
    }
  });
  it('daemon.port is never an input; shown read-only with guidance', () => {
    expect(js).not.toMatch(/data-key="daemon/);
    expect(js).not.toMatch(/data-field="daemon/);
    expect(js).toContain('crontick config set daemon.port');
    expect(js).toContain('stop the daemon');
  });
  it('engine UI: add/remove engines, args rows, env rows; default engine protected', () => {
    for (const s of ['data-act="add-engine"', 'data-act="remove-engine"', 'data-act="add-arg"', 'data-act="remove-arg"', 'data-act="add-env"', 'data-act="remove-env"']) {
      expect(js).toContain(s);
    }
    expect(js).toContain('default engine');
  });
  it('in-flight choice offers stop / wait / cancel', () => {
    expect(js).toContain('RUNS_IN_FLIGHT');
    expect(js).toContain('data-inflight="stop"');
    expect(js).toContain('data-inflight="wait"');
    expect(html).toContain('id="settings-inflight"');
  });
  it('shows paused state with pause/resume controls', () => {
    expect(html).toContain('id="paused-badge"');
    expect(html).toContain('id="btn-pause"');
    expect(js).toContain('/api/daemon/pause');
    expect(js).toContain('/api/daemon/resume');
    expect(js).toContain('/api/daemon/status');
  });
  it('css uses rem only for sizes, no px font-size', () => {
    expect(css).toContain('.settings-');
    expect(css).not.toMatch(/font-size:\s*[\d.]+px/);
  });
});

describe('served over HTTP', () => {
  let h: ApiHarness;
  beforeAll(async () => { h = await startApiHarness('dashboard-settings'); });
  afterAll(async () => { await h.close(); });
  it('serves the settings markup and script', async () => {
    const page = await fetch(`${h.baseUrl}/dashboard`).then((r) => r.text());
    expect(page).toContain('id="settings-modal"');
    const script = await fetch(`${h.baseUrl}/dashboard/dashboard.js`).then((r) => r.text());
    expect(script).toContain('buildSettingsOps');
  });
  it('status exposes paused and pause/resume toggle it (the endpoints the controls call)', async () => {
    expect((await h.call('GET', '/api/daemon/status')).data.paused).toBe(false);
    expect((await h.call('POST', '/api/daemon/pause')).data.paused).toBe(true);
    expect((await h.call('GET', '/api/daemon/status')).data.paused).toBe(true);
    expect((await h.call('POST', '/api/daemon/resume')).data.paused).toBe(false);
  });
});
