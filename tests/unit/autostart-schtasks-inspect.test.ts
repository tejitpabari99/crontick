import { describe, expect, it } from 'vitest';
import { SchtasksBackend } from '../../src/autostart/schtasks.js';
import { TASK_NAME, renderTaskXml } from '../../src/autostart/taskxml.js';
import type { AutostartDeps, AutostartSpec } from '../../src/autostart/types.js';

const spec: AutostartSpec = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  daemonScript: 'C:\\app\\dist\\daemon\\index.js',
  cliScript: 'C:\\app\\dist\\cli\\index.js',
  env: {},
};
const ST = 'C:\\Windows\\System32\\schtasks.exe';
const XML_CMD = `${ST} /query /tn ${TASK_NAME} /xml`;
const CSV_CMD = `${ST} /query /tn ${TASK_NAME} /fo csv /v /nh`;
const XML = renderTaskXml(spec, 'S-1-5-21-1-2-3-1001');

type R = { code: number; stdout?: string; stderr?: string };

function make(responses: Record<string, R | 'throw'>) {
  const calls: string[][] = [];
  const deps: AutostartDeps = {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    homedir: 'C:\\Users\\u',
    exec: async (file, args) => {
      calls.push([file, ...args]);
      const r = responses[[file, ...args].join(' ')];
      if (r === 'throw') throw new Error('boom');
      return { code: r?.code ?? 1, stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' };
    },
    fs: {} as AutostartDeps['fs'],
  };
  return { backend: new SchtasksBackend(deps), calls };
}

// 12 columns as printed by `schtasks /query /v /fo csv /nh`; order is stable, text is localized.
const row = (status: string, last: string) =>
  `"HOST","\\crontick\\daemon","N/A","${status}","Nur interaktiv","30.11.1999 00:00:00","${last}","crontick","node.exe ...","","","Aktiviert"\r\n`;

describe('SchtasksBackend.inspect', () => {
  it('missing task: registered false, never throws', async () => {
    expect(await make({ [XML_CMD]: { code: 1, stderr: 'FEHLER: nicht gefunden' } }).backend.inspect()).toEqual({ registered: false });
  });
  it('exit 0 without <Task is not registered', async () => {
    expect(await make({ [XML_CMD]: { code: 0, stdout: 'hello' } }).backend.inspect()).toEqual({ registered: false });
  });
  it('exec throwing is not registered', async () => {
    expect(await make({ [XML_CMD]: 'throw' }).backend.inspect()).toEqual({ registered: false });
  });

  it('parses command, enabled, definitionPath and active from csv', async () => {
    const r = await make({ [XML_CMD]: { code: 0, stdout: XML }, [CSV_CMD]: { code: 0, stdout: row('Bereit', '0') } }).backend.inspect();
    expect(r.registered).toBe(true);
    expect(r.definitionPath).toBe(TASK_NAME);
    expect(r.enabledInManager).toBe(true);
    expect(r.command).toEqual({
      nodePath: spec.nodePath,
      args: [spec.cliScript, 'daemon', 'start'],
      env: {},
    });
    expect(r.active).toBe(false);
    expect(r.notes?.some((n) => n.includes('taskschd.msc'))).toBe(true);
    expect(r.notes?.some((n) => /flash/i.test(n))).toBe(true);
    expect(r.notes?.some((n) => /launcher task, not the daemon/.test(n))).toBe(true);
  });

  it('localized status is ignored; last result 267009 means running', async () => {
    const r = await make({ [XML_CMD]: { code: 0, stdout: XML }, [CSV_CMD]: { code: 0, stdout: row('Wird ausgeführt', '267009') } }).backend.inspect();
    expect(r.active).toBe(true);
  });

  it('English Running status is active', async () => {
    const r = await make({ [XML_CMD]: { code: 0, stdout: XML }, [CSV_CMD]: { code: 0, stdout: row('Running', '0') } }).backend.inspect();
    expect(r.active).toBe(true);
  });

  it('notes a nonzero last result', async () => {
    const r = await make({ [XML_CMD]: { code: 0, stdout: XML }, [CSV_CMD]: { code: 0, stdout: row('Ready', '-2147020576') } }).backend.inspect();
    expect(r.active).toBe(false);
    expect(r.notes?.some((n) => n.includes('-2147020576'))).toBe(true);
  });

  it('disabled task: enabledInManager false', async () => {
    const x = XML.replace('<Enabled>true</Enabled>\n    <AllowStartOnDemand>', '<Enabled>false</Enabled>\n    <AllowStartOnDemand>');
    const r = await make({ [XML_CMD]: { code: 0, stdout: x }, [CSV_CMD]: { code: 0, stdout: row('Disabled', '0') } }).backend.inspect();
    expect(r.enabledInManager).toBe(false);
  });

  it.each([
    ['garbage', 'not,csv'],
    ['empty', ''],
    ['non-numeric last result', row('Ready', 'abc')],
  ])('csv %s: active undefined plus a note', async (_n, out) => {
    const r = await make({ [XML_CMD]: { code: 0, stdout: XML }, [CSV_CMD]: { code: 0, stdout: out } }).backend.inspect();
    expect(r.registered).toBe(true);
    expect(r.active).toBeUndefined();
    expect(r.notes?.some((n) => /active|last result/i.test(n))).toBe(true);
  });

  it('csv failure or throw: active undefined plus a note', async () => {
    for (const csv of [{ code: 1 } as R, 'throw' as const]) {
      const r = await make({ [XML_CMD]: { code: 0, stdout: XML }, [CSV_CMD]: csv }).backend.inspect();
      expect(r.registered).toBe(true);
      expect(r.active).toBeUndefined();
      expect(r.notes?.length).toBeGreaterThan(1);
    }
  });

  it('tolerates BOM and NUL-interleaved (UTF-16 read as bytes) xml', async () => {
    const mangled = '\ufeff' + [...XML].join('\u0000') + '\u0000';
    const r = await make({ [XML_CMD]: { code: 0, stdout: mangled }, [CSV_CMD]: { code: 0, stdout: row('Ready', '0') } }).backend.inspect();
    expect(r.registered).toBe(true);
    expect(r.command?.nodePath).toBe(spec.nodePath);
  });

  it('registered but unparsable command: note, no command', async () => {
    const r = await make({ [XML_CMD]: { code: 0, stdout: '<Task><Actions/></Task>' }, [CSV_CMD]: { code: 0, stdout: row('Ready', '0') } }).backend.inspect();
    expect(r.registered).toBe(true);
    expect(r.command).toBeUndefined();
    expect(r.notes?.some((n) => /command/i.test(n))).toBe(true);
  });

  it('only read-only queries are issued', async () => {
    const h = make({ [XML_CMD]: { code: 0, stdout: XML }, [CSV_CMD]: { code: 0, stdout: row('Ready', '0') } });
    await h.backend.inspect();
    expect(h.calls.every((c) => c[1] === '/query')).toBe(true);
  });
});
