import { win32 } from 'node:path';
import { CrontickError } from '../errors.js';
import { dataDir } from '../paths.js';
import { TASK_NAME, encodeTaskXml, renderTaskXml } from './taskxml.js';
import type { AutostartBackend, AutostartDeps, AutostartSpec, BackendInspection } from './types.js';

const text = (r: { stderr: string; stdout: string }): string => (r.stderr || r.stdout).trim();

/** Windows Task Scheduler backend: registers a logon task from an XML definition via `schtasks.exe`. */
export class SchtasksBackend implements AutostartBackend {
  readonly mechanism = 'schtasks' as const;

  constructor(private readonly deps: AutostartDeps) {}

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
      if ((await this.schtasks('/query', '/tn', TASK_NAME)).code === 0) return { ok: true };
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
    const xml = encodeTaskXml(renderTaskXml(spec, sid));
    const file = win32.join(dataDir(spec.env), 'autostart', 'task.xml');
    await this.deps.fs.mkdir(win32.dirname(file), { recursive: true });
    await this.deps.fs.writeFile(file, xml, { mode: 0o600 });
    try {
      const r = await this.schtasks('/create', '/tn', TASK_NAME, '/xml', file, '/f');
      if (r.code !== 0) {
        throw new CrontickError('AUTOSTART_FAILED', `schtasks /create ${TASK_NAME} failed (exit ${r.code}): ${text(r)}`);
      }
    } finally {
      await this.deps.fs.rm(file, { force: true });
    }
    return { definitionPath: TASK_NAME };
  }

  async uninstall(): Promise<{ removed: boolean }> {
    if ((await this.schtasks('/query', '/tn', TASK_NAME)).code !== 0) return { removed: false };
    const r = await this.schtasks('/delete', '/tn', TASK_NAME, '/f');
    if (r.code !== 0) {
      throw new CrontickError('AUTOSTART_FAILED', `schtasks /delete ${TASK_NAME} failed (exit ${r.code}): ${text(r)}`);
    }
    return { removed: true };
  }

  // TODO(SP09 Task 4): real inspect via `/query /xml` + csv.
  async inspect(): Promise<BackendInspection> {
    return { registered: false };
  }
}
