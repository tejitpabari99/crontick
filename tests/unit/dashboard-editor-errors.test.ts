/** Dashboard job editor error mapping, trust reveal, in-flight choice and success flow (SP04 Task 7). */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const js = readFileSync(resolve('src/dashboard/dashboard.js'), 'utf-8');
const css = readFileSync(resolve('src/dashboard/dashboard.css'), 'utf-8');

interface Mapped { code: string; message: string; fields: string[]; folders: string[]; runs: unknown[] }
interface Pure {
  mapEditorError(status: number, body: unknown): Mapped;
  shouldRevealTrust(mapped: Mapped, meta: unknown, engine: string): boolean;
  editorTrustKey(values: { engine: string; cwd: string }): string;
  appendSaveOptions(url: string, opts: { trustFolder?: boolean; inFlight?: string }): string;
}
function loadPure(): Pure {
  const m = /\/\/ <editor-pure>([\s\S]*?)\/\/ <\/editor-pure>/.exec(js);
  expect(m, 'editor-pure block').not.toBeNull();
  return new Function(`${m![1]}; return { mapEditorError, shouldRevealTrust, editorTrustKey, appendSaveOptions };`)() as Pure;
}
const p = loadPure();
const err = (code: string, message: string, details?: unknown) => ({ error: { code, message, details } });

describe('mapEditorError', () => {
  it('INVALID_CWD -> cwd field, server message kept', () => {
    const m = p.mapEditorError(400, err('INVALID_CWD', 'Working directory does not exist: /x', { cwd: '/x' }));
    expect(m.fields).toEqual(['cwd']);
    expect(m.message).toBe('Working directory does not exist: /x');
  });
  it('JOB_ALREADY_EXISTS -> alias field', () => {
    expect(p.mapEditorError(409, err('JOB_ALREADY_EXISTS', 'dup')).fields).toEqual(['alias']);
  });
  it('CWD_CHANGE_BREAKS_SESSION -> cwd + sessionId + reuseSession', () => {
    expect(p.mapEditorError(400, err('CWD_CHANGE_BREAKS_SESSION', 'x', { from: '/a', to: '/b' })).fields).toEqual(['cwd', 'sessionId', 'reuseSession']);
  });
  it('VALIDATION_ERROR maps zod format() paths to fields', () => {
    const details = {
      _errors: [],
      schedule: { cron: { _errors: ['bad cron'] }, _errors: [] },
      action: { _errors: [], cwd: { _errors: ['Required'] }, args: { 0: { _errors: ['bad'] }, _errors: [] }, timeoutSec: { _errors: ['neg'] } },
      retry: { max: { _errors: ['neg'] }, _errors: [] },
      overlap: { _errors: ['bad'] },
    };
    const m = p.mapEditorError(400, err('VALIDATION_ERROR', 'Invalid job', details));
    expect(m.fields.sort()).toEqual(['args', 'cwd', 'overlap', 'retryMax', 'schedule', 'timeoutSec']);
  });
  it('VALIDATION_ERROR string details (action.cwd is required) and unknown paths', () => {
    expect(p.mapEditorError(400, err('VALIDATION_ERROR', 'action.cwd is required', { cwd: 'action.cwd is required' })).fields).toEqual(['cwd']);
    expect(p.mapEditorError(400, err('VALIDATION_ERROR', 'x', { weird: { _errors: ['e'] } })).fields).toEqual([]);
  });
  it('TRUST_REQUIRED exposes folders; RUNS_IN_FLIGHT exposes runs', () => {
    const t = p.mapEditorError(400, err('TRUST_REQUIRED', 'untrusted', { cwd: '/a', folders: ['/a', '/b'] }));
    expect(t.folders).toEqual(['/a', '/b']);
    const f = p.mapEditorError(409, err('RUNS_IN_FLIGHT', '1 run', { runs: [{ id: 'r1' }] }));
    expect(f.runs).toEqual([{ id: 'r1' }]);
  });
  it('missing body falls back to a generic message', () => {
    const m = p.mapEditorError(500, null);
    expect(m.message).toBe('Save failed (500)');
    expect(m.fields).toEqual([]);
  });
});

describe('trust reveal decision', () => {
  const meta = { engines: [{ name: 'claude', supportsTrust: true }, { name: 'raw', supportsTrust: false }] };
  const trust = p.mapEditorError(400, err('TRUST_REQUIRED', 't', { folders: ['/a'] }));
  it('only for TRUST_REQUIRED on an engine that supports trust', () => {
    expect(p.shouldRevealTrust(trust, meta, 'claude')).toBe(true);
    expect(p.shouldRevealTrust(trust, meta, 'raw')).toBe(false);
    expect(p.shouldRevealTrust(trust, meta, 'nope')).toBe(false);
    expect(p.shouldRevealTrust(p.mapEditorError(400, err('INVALID_CWD', 'x')), meta, 'claude')).toBe(false);
  });
  it('key changes with engine or directory (trimmed)', () => {
    const k = p.editorTrustKey({ engine: 'claude', cwd: '/a' });
    expect(p.editorTrustKey({ engine: 'claude', cwd: ' /a ' })).toBe(k);
    expect(p.editorTrustKey({ engine: 'raw', cwd: '/a' })).not.toBe(k);
    expect(p.editorTrustKey({ engine: 'claude', cwd: '/b' })).not.toBe(k);
  });
});

describe('appendSaveOptions', () => {
  it('adds trustFolder / inFlight only when set', () => {
    expect(p.appendSaveOptions('/api/jobs?prepare=1', {})).toBe('/api/jobs?prepare=1');
    expect(p.appendSaveOptions('/api/jobs?prepare=1', { trustFolder: true })).toBe('/api/jobs?prepare=1&trustFolder=1');
    expect(p.appendSaveOptions('/api/jobs/x?prepare=1', { inFlight: 'wait' })).toBe('/api/jobs/x?prepare=1&inFlight=wait');
  });
});

describe('wiring', () => {
  it('trust checkbox is unchecked, labelled, never auto-checked', () => {
    expect(js).toContain('Trust this folder in Claude:');
    expect(js).toMatch(/data-editor-field="trustFolderCheck"(?![^>]*checked)/);
  });
  it('in-flight panel offers stop, wait, cancel (SP03 strings)', () => {
    expect(js).toContain('Stop running jobs, then save');
    expect(js).toContain('Pause and wait for runs, then save');
    expect(js).toContain('Cancel save');
    expect(js).toContain('data-editor-inflight');
  });
  it('success toasts and refreshes; error hook uses mapEditorError', () => {
    expect(js).toMatch(/Job created/);
    expect(js).toMatch(/Job updated/);
    expect(js).toContain('mapEditorError(res.status, body)');
  });
  it('css for trust box is rem-only', () => {
    expect(css).toContain('.editor-trust');
  });
});
