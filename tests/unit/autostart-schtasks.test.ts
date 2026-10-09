import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SchtasksBackend } from '../../src/autostart/schtasks.js';
import { TASK_NAME, encodeTaskXml, renderTaskXml } from '../../src/autostart/taskxml.js';
import type { AutostartDeps, AutostartSpec } from '../../src/autostart/types.js';
import { CrontickError } from '../../src/errors.js';

const spec: AutostartSpec = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  daemonScript: 'C:\\app\\dist\\daemon\\index.js',
  cliScript: 'C:\\app\\dist\\cli\\index.js',
  env: { CRONTICK_HOME: 'C:\\data\\ct' },
};
const SID = 'S-1-5-21-1-2-3-1001';
const ST = 'C:\\Windows\\System32\\schtasks.exe';
const WHOAMI = 'C:\\Windows\\System32\\whoami.exe';
const XML_PATH = win32.join('C:\\data\\ct', 'autostart', 'task.xml');
type R = { code: number; stdout?: string; stderr?: string };

function harness(responses: Record<string, R> = {}, opts: { throwExec?: boolean } = {}) {
  const calls: string[][] = [];
  const files = new Map<string, string | Uint8Array>();
  const writes: string[] = [];
  const dirs: string[] = [];
  const fileAtCreate: Array<string | Uint8Array | undefined> = [];
  const defaults: Record<string, R> = {
    [`${WHOAMI} /user /fo csv /nh`]: { code: 0, stdout: `"DESKTOP\\u","${SID}"\r\n` },
    ...responses,
  };
  const deps: AutostartDeps = {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    homedir: 'C:\\Users\\u',
    exec: async (file, args) => {
      calls.push([file, ...args]);
      if (opts.throwExec) throw new Error('ENOENT');
      if (args[0] === '/create') fileAtCreate.push(files.get(args[4]!));
      const r = defaults[[file, ...args].join(' ')] ?? { code: 0 };
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    fs: {
      readFile: async () => {
        throw new Error('ENOENT');
      },
      writeFile: async (p, d) => {
        files.set(p, d);
        writes.push(p);
      },
      mkdir: async (p) => void dirs.push(p),
      rm: async (p) => void files.delete(p),
      access: async (p) => {
        if (!files.has(p)) throw new Error('ENOENT');
      },
    },
  };
  return { backend: new SchtasksBackend(deps), calls, files, writes, dirs, fileAtCreate };
}

const QUERY = `${ST} /query /tn ${TASK_NAME}`;

describe('SchtasksBackend', () => {
  it('has mechanism schtasks', () => {
    expect(harness().backend.mechanism).toBe('schtasks');
  });

  describe('available', () => {
    it('ok on exit 0', async () => {
      expect(await harness().backend.available()).toEqual({ ok: true });
    });
    it('ok when task not found but schtasks works', async () => {
      const h = harness({ [QUERY]: { code: 1, stderr: 'ERROR: not found' } });
      expect(await h.backend.available()).toEqual({ ok: true });
    });
    it('unavailable with stderr when schtasks itself is blocked', async () => {
      const h = harness({
        [QUERY]: { code: 1, stderr: 'blocked' },
        [`${ST} /query /fo csv /nh`]: { code: 1, stderr: 'Access is denied by policy' },
      });
      const r = await h.backend.available();
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toContain('Access is denied by policy');
      expect(h.writes).toEqual([]);
    });
    it('unavailable when exec throws', async () => {
      const r = await harness({}, { throwExec: true }).backend.available();
      expect(r.ok).toBe(false);
    });
  });

  describe('install', () => {
    it('resolves SID, writes UTF-16LE xml, creates, removes temp file', async () => {
      const h = harness();
      const r = await h.backend.install(spec);
      expect(r).toEqual({ definitionPath: TASK_NAME });
      expect(h.calls).toEqual([
        [WHOAMI, '/user', '/fo', 'csv', '/nh'],
        [ST, '/create', '/tn', TASK_NAME, '/xml', XML_PATH, '/f'],
      ]);
      expect(h.dirs).toContain(win32.dirname(XML_PATH));
      const written = h.fileAtCreate[0] as Uint8Array;
      expect(Buffer.from(written).equals(encodeTaskXml(renderTaskXml(spec, SID)))).toBe(true);
      expect(h.files.has(XML_PATH)).toBe(false);
    });
    it('reinstall is the same sequence (/f overwrites)', async () => {
      const h = harness();
      await h.backend.install(spec);
      await h.backend.install(spec);
      expect(h.calls.filter((c) => c[1] === '/create')).toHaveLength(2);
      expect(h.files.size).toBe(0);
    });
    it('removes temp file and throws AUTOSTART_FAILED with stderr on create failure', async () => {
      const h = harness({
        [`${ST} /create /tn ${TASK_NAME} /xml ${XML_PATH} /f`]: { code: 1, stderr: 'ERROR: Access is denied.' },
      });
      const err = await h.backend.install(spec).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CrontickError);
      expect((err as CrontickError).code).toBe('AUTOSTART_FAILED');
      expect((err as Error).message).toContain('Access is denied');
      expect(h.files.has(XML_PATH)).toBe(false);
    });
    it('fails before writing anything when SID lookup fails', async () => {
      const h = harness({ [`${WHOAMI} /user /fo csv /nh`]: { code: 1, stderr: 'nope' } });
      await expect(h.backend.install(spec)).rejects.toMatchObject({ code: 'AUTOSTART_FAILED' });
      expect(h.writes).toEqual([]);
    });
    it('fails when whoami output has no SID', async () => {
      const h = harness({ [`${WHOAMI} /user /fo csv /nh`]: { code: 0, stdout: 'garbage' } });
      await expect(h.backend.install(spec)).rejects.toMatchObject({ code: 'AUTOSTART_FAILED' });
      expect(h.writes).toEqual([]);
    });
  });

  describe('uninstall', () => {
    it('absent: removed false, no delete', async () => {
      const h = harness({ [QUERY]: { code: 1 } });
      expect(await h.backend.uninstall()).toEqual({ removed: false });
      expect(h.calls.some((c) => c[1] === '/delete')).toBe(false);
    });
    it('present: queries then deletes', async () => {
      const h = harness();
      expect(await h.backend.uninstall()).toEqual({ removed: true });
      expect(h.calls).toEqual([
        [ST, '/query', '/tn', TASK_NAME],
        [ST, '/delete', '/tn', TASK_NAME, '/f'],
      ]);
    });
    it('delete failure throws AUTOSTART_FAILED', async () => {
      const h = harness({ [`${ST} /delete /tn ${TASK_NAME} /f`]: { code: 1, stderr: 'denied' } });
      await expect(h.backend.uninstall()).rejects.toMatchObject({ code: 'AUTOSTART_FAILED' });
    });
  });
});
