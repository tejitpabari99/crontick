import { win32 } from 'node:path';
import { CrontickError } from '../errors.js';
import { dataDir } from '../paths.js';
import { TASK_NAME, encodeTaskXml, parseTaskXml, renderTaskXml } from './taskxml.js';
import type { AutostartBackend, AutostartDeps, AutostartSpec, BackendInspection } from './types.js';

const text = (r: { stderr: string; stdout: string }): string => (r.stderr || r.stdout).trim();

/** Windows Task Scheduler backend: registers a logon task from an XML definition via `schtasks.exe`. */
export class SchtasksBackend implements AutostartBackend {
  readonly mechanism = 'schtasks' as const;

  /** `taskName` is a test seam (integration tests use a unique name so they never touch a real install). */
  constructor(private readonly deps: AutostartDeps, private readonly taskName: string = TASK_NAME) {}

  /** Matches the `Arguments` that `renderTaskXml` writes: `<cli> daemon start [--home <dir>]`. */
  expectedCommand(spec: AutostartSpec): string[] {
    const home = spec.env['CRONTICK_HOME'];
    return [spec.cliScript, 'daemon', 'start', ...(home ? ['--home', home] : [])];
  }

  /** Absolute System32 path; never resolved through PATH. */
  private system32(exe: string): string {
    const root = this.deps.env['SystemRoot'] ?? this.deps.env['windir'] ?? 'C:\\Windows';
    return win32.join(root, 'System32', exe);
  }

  private schtasks(...args: string[]) {
    return this.deps.exec(this.system32('schtasks.exe'), args);
  }

  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      // Exit 0 or "task not found" both prove schtasks works; "not found" is told apart from a
      // blocked tool without localized text by probing a plain listing.
      if ((await this.schtasks('/query', '/tn', this.taskName)).code === 0) return { ok: true };
      const probe = await this.schtasks('/query', '/fo', 'csv', '/nh');
      if (probe.code === 0) return { ok: true };
      return { ok: false, reason: `schtasks.exe is not usable: ${text(probe) || `exit ${probe.code}`}` };
    } catch (e) {
      return { ok: false, reason: `schtasks.exe is not available: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** Current user's SID from `whoami /user /fo csv /nh` (second CSV column). */
  private async currentSid(): Promise<string> {
    const r = await this.deps.exec(this.system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
    const sid = r.code === 0 ? /"[^"]*"\s*,\s*"(S-1-[\d-]+)"/.exec(r.stdout)?.[1] : undefined;
    if (!sid) {
      throw new CrontickError('AUTOSTART_FAILED', `Cannot determine the current user SID (whoami exit ${r.code}): ${text(r)}`);
    }
    return sid;
  }

  async install(spec: AutostartSpec): Promise<{ definitionPath: string }> {
    const sid = await this.currentSid();
    const xml = encodeTaskXml(renderTaskXml(spec, sid, this.taskName));
    const file = win32.join(dataDir(spec.env), 'autostart', 'task.xml');
    await this.deps.fs.mkdir(win32.dirname(file), { recursive: true });
    await this.deps.fs.writeFile(file, xml, { mode: 0o600 });
    try {
      const r = await this.schtasks('/create', '/tn', this.taskName, '/xml', file, '/f');
      if (r.code !== 0) {
        throw new CrontickError('AUTOSTART_FAILED', `schtasks /create ${this.taskName} failed (exit ${r.code}): ${text(r)}`);
      }
    } finally {
      await this.deps.fs.rm(file, { force: true });
    }
    return { definitionPath: this.taskName };
  }

  async uninstall(): Promise<{ removed: boolean }> {
    if ((await this.schtasks('/query', '/tn', this.taskName)).code !== 0) return { removed: false };
    const r = await this.schtasks('/delete', '/tn', this.taskName, '/f');
    if (r.code !== 0) {
      throw new CrontickError('AUTOSTART_FAILED', `schtasks /delete ${this.taskName} failed (exit ${r.code}): ${text(r)}`);
    }
    return { removed: true };
  }

  /** Read-only. Task XML (locale-independent element names) for the definition; CSV by column index for run state. */
  async inspect(): Promise<BackendInspection> {
    let xml: string;
    try {
      const r = await this.schtasks('/query', '/tn', this.taskName, '/xml');
      xml = cleanOutput(r.stdout);
      if (r.code !== 0 || !xml.includes('<Task')) return { registered: false };
    } catch {
      return { registered: false };
    }
    const out: BackendInspection = { registered: true, definitionPath: this.taskName };
    const notes: string[] = [];
    const parsed = parseTaskXml(xml);
    if (parsed) {
      out.command = { nodePath: parsed.nodePath, args: parsed.args, env: parsed.env };
      out.enabledInManager = parsed.enabled;
    } else {
      notes.push(`Could not parse the command from the ${this.taskName} task definition.`);
    }
    const run = await this.runState();
    if (run.active !== undefined) out.active = run.active;
    if (run.note) notes.push(run.note);
    notes.push(UI_HINT, FLASH_HINT, ACTIVE_HINT);
    out.notes = notes;
    return out;
  }

  /** Active and Last Result from `/query /v /fo csv /nh`; the status text is localized, so it is never relied on alone. */
  private async runState(): Promise<{ active?: boolean; note?: string }> {
    const unknown = { note: 'Could not determine the task run state (unparseable schtasks output); active state unknown.' };
    try {
      const r = await this.schtasks('/query', '/tn', this.taskName, '/fo', 'csv', '/v', '/nh');
      if (r.code !== 0) return unknown;
      const cols = parseCsvRow(cleanOutput(r.stdout));
      const last = cols[LAST_RESULT_COL]?.trim();
      if (cols.length <= LAST_RESULT_COL || last === undefined || !/^-?\d+$/.test(last)) return unknown;
      const code = Number(last);
      const active = code === TASK_RUNNING || /^running$/i.test((cols[STATUS_COL] ?? '').trim());
      const note = active || code === 0 || code === TASK_NOT_YET_RUN ? undefined : `Last task result: ${last} (0x${(code >>> 0).toString(16)}).`;
      return note ? { active, note } : { active };
    } catch {
      return unknown;
    }
  }
}

const UI_HINT = 'Inspect the task in Task Scheduler: run taskschd.msc and open the \\crontick folder.';
const FLASH_HINT = 'The logon task runs a short-lived launcher, so a console window may flash briefly (about 30 seconds after logon).';

const ACTIVE_HINT = 'Active reflects the short-lived launcher task, not the daemon: "no" is normal while the daemon runs. Use `crontick daemon status` for the daemon.';

// `schtasks /query /v /fo csv` column order is stable across locales; text is not.
const STATUS_COL = 3;
const LAST_RESULT_COL = 6;
/** SCHED_S_TASK_RUNNING */
const TASK_RUNNING = 267009;
/** SCHED_S_TASK_HAS_NOT_RUN */
const TASK_NOT_YET_RUN = 267011;

/** Drops a BOM and NULs (UTF-16 output decoded as 8-bit), tolerating a code-page mismatch. */
function cleanOutput(s: string): string {
  return s.replace(/^\uFEFF/, '').split('\u0000').join('').replace(/\uFEFF/g, '');
}

/** First CSV record with quoted fields (doubled quotes escape). */
function parseCsvRow(s: string): string[] {
  const line = s.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const out: string[] = [];
  const re = /"((?:[^"]|"")*)"|([^,]*)/g;
  let pos = 0;
  while (pos <= line.length) {
    re.lastIndex = pos;
    const m = re.exec(line);
    if (!m) break;
    out.push(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]!);
    pos = re.lastIndex;
    if (line[pos] === ',') pos += 1;
    else break;
  }
  return out;
}
