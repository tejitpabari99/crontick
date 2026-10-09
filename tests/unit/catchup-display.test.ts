/** SP10 Task 6: catch-up display (labels, `jobs get`, dashboard badge/editor checkbox) and export/import round trip. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeSchedule } from '../../src/utils/schedule-label.js';
import { stripExportIds, stripWebhookSecrets } from '../../src/share.js';
import { ExportFileSchema } from '../../src/job-input.js';
import { FAKE_ENGINE_NAME, writeFakeEngineConfig } from '../helpers/fake-engine.js';

const js = readFileSync(resolve('src/dashboard/dashboard.js'), 'utf-8');
const css = readFileSync(resolve('src/dashboard/dashboard.css'), 'utf-8');
const CLI = resolve('dist/cli/index.js');

describe('describeSchedule catch-up suffix', () => {
  const none = () => undefined;
  it('appends " (catch-up)" only when catchUp is true', () => {
    expect(describeSchedule({ kind: 'cron', cron: '0 9 * * *' }, none, true)).toBe('0 9 * * * (catch-up)');
    expect(describeSchedule({ kind: 'interval', everySec: 60 }, none, true)).toBe('every 60s (catch-up)');
    expect(describeSchedule({ kind: 'one-shot', runAt: '2030-01-01T00:00:00.000Z' }, none, true)).toBe('once at 2030-01-01T00:00:00.000Z (catch-up)');
    expect(describeSchedule({ kind: 'cron', cron: '0 9 * * *' }, none, false)).toBe('0 9 * * *');
    expect(describeSchedule({ kind: 'cron', cron: '0 9 * * *' }, none)).toBe('0 9 * * *');
  });
});

describe('export/import carries catchUp', () => {
  it('strip helpers keep catchUp and the import schema parses it', () => {
    const rows = stripWebhookSecrets(stripExportIds([{ id: 'A', catchUp: true, schedule: { kind: 'cron' } }]) as Array<{ catchUp: boolean; schedule: { kind: string } }>);
    expect(rows[0].catchUp).toBe(true);
    const parsed = ExportFileSchema.parse({
      schema: 1,
      jobs: [{ catchUp: true, schedule: { kind: 'cron', cron: '0 9 * * *' }, action: { kind: 'prompt', prompt: 'x' } }],
    });
    expect(parsed.jobs[0].catchUp).toBe(true);
  });
});

describe('dashboard catch-up UI (asset strings)', () => {
  it('registry flags time kinds with supportsCatchUp and no other kind', () => {
    const body = /const SCHEDULE_KINDS = \[([\s\S]*?)\n\];/.exec(js)![1];
    const entries = body.split(/\n {2}\{\n/).slice(1);
    const flagged = entries.filter((e) => /supportsCatchUp: true/.test(e)).map((e) => /kind: '([\w-]+)'/.exec(e)![1]);
    expect(flagged).toEqual(['cron', 'interval', 'one-shot']);
  });
  it('editor has the catch-up checkbox, hides and clears it on unsupported kinds', () => {
    expect(js).toContain('Catch up missed run on daemon start');
    expect(js).toContain('data-editor-field="catchUp"');
    expect(js).toMatch(/supportsCatchUp/);
    expect(js).toMatch(/'--catch-up': 'catchUp'/);
    expect(js).toMatch(/'--no-catch-up': 'catchUp'/);
  });
  it('rows and drawer show a catch-up badge', () => {
    expect(js).toContain('badge-catchup');
    expect(css).toContain('.badge-catchup');
  });
});

describe('editor payload logic', () => {
  const m = /\/\/ <editor-pure>([\s\S]*?)\/\/ <\/editor-pure>/.exec(js)!;
  const p = new Function(`${m[1]}; return { jobToEditorValues, blankEditorValues, buildCreateBody, buildEditPatch };`)() as {
    jobToEditorValues(j: unknown): Record<string, unknown>;
    blankEditorValues(m: unknown): Record<string, unknown>;
    buildCreateBody(v: unknown, s: unknown): Record<string, unknown>;
    buildEditPatch(b: unknown, d: unknown, s: unknown): Record<string, unknown>;
  };
  const cron = { kind: 'cron', cron: '0 9 * * *' };
  const job = { alias: 'a', catchUp: true, schedule: cron, overlap: 'skip', retry: { max: 0 }, action: { kind: 'prompt', prompt: 'p', cwd: '/tmp', engine: 'raw' } };

  it('reads catchUp from the job and defaults blank to false', () => {
    expect(p.jobToEditorValues(job).catchUp).toBe(true);
    expect(p.blankEditorValues({}).catchUp).toBe(false);
  });
  it('create body sends catchUp only when ticked on a supporting kind', () => {
    const v = { ...p.blankEditorValues({}), prompt: 'x', cwd: '/tmp', catchUp: true };
    expect(p.buildCreateBody(v, cron).catchUp).toBe(true);
    expect(p.buildCreateBody({ ...v, catchUp: false }, cron)).not.toHaveProperty('catchUp');
    expect(p.buildCreateBody(v, { kind: 'webhook' })).not.toHaveProperty('catchUp');
  });
  it('edit patch carries a catchUp change and nothing when unchanged', () => {
    const base = p.jobToEditorValues(job);
    expect(p.buildEditPatch(base, { ...base, catchUp: false }, undefined)).toEqual({ catchUp: false });
    expect(p.buildEditPatch(base, base, undefined)).toEqual({});
  });
});

describe('CLI jobs get / jobs list', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      spawnSync(process.execPath, [CLI, 'daemon', 'stop'], { env: { ...process.env, CRONTICK_HOME: d } });
      rmSync(d, { recursive: true, force: true });
    }
  });
  it('prints catch-up on|off and labels list rows', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'crontick-cu-')));
    dirs.push(home);
    writeFakeEngineConfig(home);
    const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8', env: { ...process.env, CRONTICK_HOME: home, CRONTICK_VERBOSE: '' }, timeout: 30_000 });
    const common = ['-p', 'x', '--runner', FAKE_ENGINE_NAME, '--every', '1h'];
    expect(run(['jobs', 'new', '-a', 'cu-on', ...common, '--catch-up']).status).toBe(0);
    expect(run(['jobs', 'new', '-a', 'cu-off', ...common]).status).toBe(0);
    expect(run(['jobs', 'get', 'cu-on']).stdout).toContain('catch-up: on');
    expect(run(['jobs', 'get', 'cu-off']).stdout).toContain('catch-up: off');
    const [header, ...rows] = run(['jobs', 'list']).stdout.trim().split('\n').map((l) => l.split('\t'));
    const alias = header.indexOf('alias');
    const label = header.indexOf('scheduleLabel');
    expect(rows.find((r) => r[alias] === 'cu-on')![label]).toBe('every 3600s (catch-up)');
    expect(rows.find((r) => r[alias] === 'cu-off')![label]).toBe('every 3600s');
  });
});
