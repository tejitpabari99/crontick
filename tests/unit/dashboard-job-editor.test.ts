/** Dashboard job editor shell + field parity (SP04 Task 5): string/HTTP assertions plus the pure body/diff helpers. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startApiHarness, type ApiHarness } from '../helpers/api-harness.js';

const read = (f: string): string => readFileSync(resolve('src/dashboard', f), 'utf-8');
const html = read('index.html');
const js = read('dashboard.js');
const css = read('dashboard.css');
const cliSrc = readFileSync(resolve('src/cli/index.ts'), 'utf-8');

type Values = Record<string, unknown>;
interface Pure {
  EDITOR_CLI_PARITY: Record<string, string | null>;
  parseOptionalNumber(text: string): number | undefined | 'invalid';
  jobToEditorValues(job: unknown): Values;
  blankEditorValues(meta: unknown): Values;
  buildCreateBody(values: Values, schedule: unknown): unknown;
  buildEditPatch(base: Values, draft: Values, schedule?: unknown): Record<string, unknown>;
  editorMissing(values: Values, isCreate: boolean): string[];
}
function loadPure(): Pure {
  const m = /\/\/ <editor-pure>([\s\S]*?)\/\/ <\/editor-pure>/.exec(js);
  expect(m, 'editor-pure block').not.toBeNull();
  return new Function(`${m![1]}; return { EDITOR_CLI_PARITY, parseOptionalNumber, jobToEditorValues, blankEditorValues, buildCreateBody, buildEditPatch, editorMissing };`)() as Pure;
}
const p = loadPure();

const job = {
  id: 'abc', alias: 'nightly', description: 'desc', enabled: true,
  schedule: { kind: 'cron', expression: '* * * * *' },
  action: {
    kind: 'prompt', prompt: 'do it', cwd: '/work', engine: 'claude', args: ['--a', '--b'],
    sessionId: 'sess', reuseSession: true, timeoutSec: 60, env: { K: 'v' }, envFile: '/e',
  },
  overlap: 'queue', retry: { max: 2, backoffSec: 45 },
};

describe('parity with commonJobOptions', () => {
  it('maps every CLI job flag to a field id (or an explicit null with a reason in the schedule/trust hooks)', () => {
    const block = /function commonJobOptions[\s\S]*?\n}\n/.exec(cliSrc)![0];
    const flags = [...block.matchAll(/\.option\(\s*['`](?:-\w, )?(--[\w-]+)/g)].map((m) => m[1]);
    // scheduleFlag() options use template strings; add them by their literal names.
    for (const f of ['--cron', '--every', '--at', '--after']) if (block.includes(`scheduleFlag('${f}')`)) flags.push(f);
    expect(flags.length).toBeGreaterThan(10);
    for (const f of flags) expect(Object.keys(p.EDITOR_CLI_PARITY), `unmapped CLI flag ${f}`).toContain(f);
  });
  it('every mapped field id has a control in dashboard.js', () => {
    for (const id of new Set(Object.values(p.EDITOR_CLI_PARITY).filter(Boolean) as string[])) {
      const section = js.slice(js.indexOf('// ── Job editor'));
      expect(section + html, `field ${id}`).toMatch(new RegExp(`data-editor-field="${id}"|'${id}'`));
    }
  });
});

describe('parseOptionalNumber', () => {
  it('blank -> undefined, number -> number, junk -> invalid', () => {
    expect(p.parseOptionalNumber('')).toBeUndefined();
    expect(p.parseOptionalNumber('  ')).toBeUndefined();
    expect(p.parseOptionalNumber(' 12 ')).toBe(12);
    expect(p.parseOptionalNumber('x')).toBe('invalid');
  });
});

describe('buildCreateBody', () => {
  const blank = p.blankEditorValues({ defaultEngine: 'claude', defaults: { overlap: 'skip', retry: { max: 0, backoffSec: 30 } } });
  const sched = { kind: 'cron', expression: '* * * * *' };
  it('blank values default engine/overlap/retry from meta; dir is empty', () => {
    expect(blank).toMatchObject({ engine: 'claude', overlap: 'skip', cwd: '', retryMax: '0', args: [] });
  });
  it('minimal body omits optional fields', () => {
    const body = p.buildCreateBody({ ...blank, prompt: 'hi', cwd: '/w' }, sched);
    expect(body).toEqual({
      schedule: sched, overlap: 'skip', retry: { max: 0 },
      action: { kind: 'prompt', prompt: 'hi', cwd: '/w', engine: 'claude' },
    });
  });
  it('includes filled fields; session id drops reuseSession; empty arg rows dropped', () => {
    const body = p.buildCreateBody({
      ...blank, alias: ' my-job ', prompt: 'hi', cwd: '/w', args: ['--x', ' ', '--y'], sessionId: 's1', reuseSession: true,
      timeoutSec: '30', retryMax: '3', backoffSec: '10', description: 'd', overlap: 'queue',
    }, sched);
    expect(body).toEqual({
      alias: 'my-job', description: 'd', schedule: sched, overlap: 'queue', retry: { max: 3, backoffSec: 10 },
      action: { kind: 'prompt', prompt: 'hi', cwd: '/w', engine: 'claude', args: ['--x', '--y'], sessionId: 's1', timeoutSec: 30 },
    });
  });
  it('reuseSession sent when no session id', () => {
    const body = p.buildCreateBody({ ...blank, prompt: 'hi', cwd: '/w', reuseSession: true }, sched) as { action: Values };
    expect(body.action.reuseSession).toBe(true);
  });
});

describe('buildEditPatch (diff only)', () => {
  const base = p.jobToEditorValues(job);
  it('jobToEditorValues reads the loaded job', () => {
    expect(base).toMatchObject({
      alias: 'nightly', prompt: 'do it', cwd: '/work', engine: 'claude', args: ['--a', '--b'], sessionId: 'sess',
      reuseSession: true, timeoutSec: '60', overlap: 'queue', retryMax: '2', backoffSec: '45', description: 'desc',
    });
  });
  it('no change -> empty patch (env/envFile never present)', () => {
    expect(p.buildEditPatch(base, { ...base })).toEqual({});
  });
  it('changing only the prompt sends only action.prompt with kind', () => {
    expect(p.buildEditPatch(base, { ...base, prompt: 'new' })).toEqual({ action: { kind: 'prompt', prompt: 'new' } });
  });
  it('blank cleared fields become null', () => {
    expect(p.buildEditPatch(base, { ...base, description: '', timeoutSec: '', sessionId: '' })).toEqual({
      description: null, action: { kind: 'prompt', timeoutSec: null, sessionId: null },
    });
  });
  it('clearing an already-empty field sends nothing', () => {
    const b = p.jobToEditorValues({ ...job, description: undefined, action: { ...job.action, timeoutSec: undefined } });
    expect(p.buildEditPatch(b, { ...b })).toEqual({});
  });
  it('args array change sends whole ordered array; policies and retry diff by leaf', () => {
    expect(p.buildEditPatch(base, { ...base, args: ['--b', '--a'], overlap: 'skip', retryMax: '5', alias: 'renamed' })).toEqual({
      alias: 'renamed', overlap: 'skip', retry: { max: 5 }, action: { kind: 'prompt', args: ['--b', '--a'] },
    });
    expect(p.buildEditPatch(base, { ...base, backoffSec: '99' })).toEqual({ retry: { backoffSec: 99 } });
  });
  it('reuseSession change is ignored while a session id is filled', () => {
    expect(p.buildEditPatch(base, { ...base, reuseSession: false })).toEqual({});
    const b = p.jobToEditorValues({ ...job, action: { ...job.action, sessionId: undefined, reuseSession: false } });
    expect(p.buildEditPatch(b, { ...b, reuseSession: true })).toEqual({ action: { kind: 'prompt', reuseSession: true } });
  });
  it('schedule hook value is passed through when provided', () => {
    const s = { kind: 'interval', everySec: 60 };
    expect(p.buildEditPatch(base, { ...base }, s)).toEqual({ schedule: s });
  });
});

describe('editorMissing', () => {
  it('create requires prompt and dir; edit requires prompt and alias', () => {
    const blank = p.blankEditorValues({ defaultEngine: 'claude', defaults: { overlap: 'skip', retry: { max: 0 } } });
    expect(p.editorMissing(blank, true)).toEqual(['prompt', 'cwd']);
    expect(p.editorMissing({ ...blank, prompt: 'x', cwd: '/w' }, true)).toEqual([]);
    expect(p.editorMissing({ ...blank, prompt: 'x', alias: '' }, false)).toEqual(['alias']);
  });
});

describe('catch-up checkbox visibility', () => {
  it('has a display:none rule for [hidden] so it beats .editor-check display:flex', () => {
    expect(css).toMatch(/\.editor-catchup\[hidden\][^{]*\{\s*display:\s*none/);
    expect(html + js).toContain('editor-catchup');
    expect(js).toMatch(/label\.hidden = !supported/);
  });
});

describe('editor markup + wiring', () => {
  it('"+" button sits before the gear; modal reuses .modal-backdrop', () => {
    expect(html).toMatch(/id="btn-new-job"[^>]*aria-label="New job"/);
    expect(html.indexOf('id="btn-new-job"')).toBeLessThan(html.indexOf('id="btn-settings"'));
    expect(html).toMatch(/<div id="job-editor" class="modal-backdrop" hidden>/);
    for (const id of ['editor-title', 'editor-close', 'editor-banner', 'editor-form', 'editor-save', 'editor-cancel']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(js).toContain('id="editor-schedule"');
    expect(html).toMatch(/id="editor-banner"[^>]*role="alert"/);
  });
  it('pencil in each row and in the drawer header', () => {
    expect(js).toContain('data-action="edit"');
    expect(html).toMatch(/id="drawer-edit"/);
  });
  it('dirty close uses the SP03 confirm string; focus returns to opener; trap', () => {
    expect(js).toContain("'Discard unsaved changes? Changes will be lost.'");
    expect(js).toContain('editorReturnFocus');
    expect(js).toContain('trapTab(e, jobEditor.querySelector');
    expect(js).toMatch(/!jobEditor\.hidden\) requestLeaveEditor\(\)/);
  });
  it('create posts prepare mode; edit loads GET /api/jobs/:id and PUTs prepare mode', () => {
    expect(js).toContain('/api/jobs?prepare=1');
    expect(js).toContain('/api/jobs/editor-meta');
    expect(js).toMatch(/\/api\/jobs\/\$\{encodeURIComponent\(editorJobId\)\}\?prepare=1/);
    expect(js).toContain("method = 'PUT'");
  });
  it('editor fetches that mutate send Content-Type: application/json', () => {
    const body = js.slice(js.indexOf('// ── Job editor'));
    const fetches = [...body.matchAll(/fetch\(url, \{ method,/g)];
    expect(fetches.length).toBeGreaterThan(0);
    for (const m of fetches) expect(body.slice(m.index!, m.index! + 120)).toContain("'Content-Type': 'application/json'");
  });
  it('openEditor guards against a stale earlier open completing late', () => {
    expect(js).toContain('const openSeq = ++editorOpenSeq');
    expect(js.match(/openSeq !== editorOpenSeq/g)!.length).toBeGreaterThanOrEqual(3);
    expect(js).toMatch(/function closeEditor\(\) \{\n {2}editorOpenSeq\+\+;/);
  });
  it('exposes hook points for schedule (T6) and server errors/trust/in-flight (T7)', () => {
    expect(js).toContain('editorScheduleHook');
    expect(js).toContain('editorHandleSaveError');
  });
  it('directory label, no default, advanced disclosure, no env controls', () => {
    expect(js).toContain("editorField('Directory', 'cwd'");
    expect(js).toContain('<details class="editor-advanced">');
    expect(js).not.toMatch(/data-editor-field="env/);
  });
  it('css rem only, no px font-size', () => {
    expect(css).toContain('.editor-');
    const section = css.slice(css.indexOf('/* ── Job editor'));
    expect(section.replace(/\b1px\b/g, "")).not.toMatch(/\d+(\.\d+)?px/);
  });
});

describe('served over HTTP', () => {
  let h: ApiHarness;
  beforeAll(async () => { h = await startApiHarness('dashboard-job-editor'); });
  afterAll(async () => { await h.close(); });
  it('serves editor markup and script', async () => {
    const page = await fetch(`${h.baseUrl}/dashboard`).then((r) => r.text());
    expect(page).toContain('id="job-editor"');
    const script = await fetch(`${h.baseUrl}/dashboard/dashboard.js`).then((r) => r.text());
    expect(script).toContain('buildEditPatch');
  });
  it('the endpoints the form calls exist', async () => {
    const meta = await h.call('GET', '/api/jobs/editor-meta');
    expect(meta.status).toBe(200);
    expect(meta.data.defaultEngine).toBeTruthy();
  });
});
