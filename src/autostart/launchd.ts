import { dirname, join } from 'node:path';
import { CrontickError } from '../errors.js';
import { PLIST_LABEL, parsePlist, plistPaths, renderPlist } from './plist.js';
import type { AutostartBackend, AutostartDeps, AutostartSpec, BackendInspection } from './types.js';

const LAUNCHCTL = '/bin/launchctl';

const LOGIN_ITEMS_NOTE =
  'Registered but not loaded in launchd; it may be switched off in System Settings > General > Login Items & Extensions.';

const DISABLED_RE = new RegExp(`"${PLIST_LABEL.replace(/\./g, '\\.')}"\\s*=>\\s*(disabled|true)`);

const text = (r: { stderr: string; stdout: string }): string => (r.stderr || r.stdout).trim();

/** launchd LaunchAgent backend: user-domain (`gui/<uid>`) bootstrap/bootout, never legacy load/unload. */
export class LaunchdBackend implements AutostartBackend {
  readonly mechanism = 'launchd' as const;

  constructor(
    private readonly deps: AutostartDeps,
    private readonly getUid: (() => number | undefined) | undefined = typeof process.getuid === 'function'
      ? () => process.getuid!()
      : undefined,
  ) {}

  private get plistPath(): string {
    return join(this.deps.homedir, 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
  }

  private uid(): number {
    const uid = this.getUid?.();
    if (uid === undefined) throw new CrontickError('AUTOSTART_FAILED', 'Cannot determine the current user id (process.getuid unavailable).');
    return uid;
  }

  private ctl(...args: string[]) {
    return this.deps.exec(LAUNCHCTL, args);
  }

  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const uid = this.getUid?.();
    if (uid === undefined) return { ok: false, reason: 'process.getuid is unavailable; cannot target a launchd user domain.' };
    try {
      const r = await this.ctl('print', `gui/${uid}`);
      if (r.code === 0) return { ok: true };
      return {
        ok: false,
        reason: `No GUI launchd session for user ${uid} (not logged in at the console, or running over SSH): ${text(r) || `exit ${r.code}`}`,
      };
    } catch (e) {
      return { ok: false, reason: `launchctl is not available: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async install(spec: AutostartSpec): Promise<{ definitionPath: string }> {
    const uid = this.uid();
    const domain = `gui/${uid}`;
    const target = `${domain}/${PLIST_LABEL}`;
    const path = this.plistPath;
    const paths = plistPaths(spec);
    await this.deps.fs.mkdir(dirname(path), { recursive: true });
    await this.deps.fs.mkdir(paths.logsDir, { recursive: true });
    await this.deps.fs.writeFile(path, renderPlist(spec, PLIST_LABEL, paths), { mode: 0o644 });

    // Never blind-bootstrap: a loaded label fails with an opaque "5: Input/output error".
    if ((await this.ctl('print', target)).code === 0) {
      const out = await this.ctl('bootout', target);
      if (out.code !== 0) throw this.failure('bootout', target, out);
    }
    let boot = await this.ctl('bootstrap', domain, path);
    if (boot.code !== 0 && (await this.isDisabled(domain))) {
      const en = await this.ctl('enable', target);
      if (en.code !== 0) throw this.failure('enable', target, en);
      boot = await this.ctl('bootstrap', domain, path);
    }
    if (boot.code !== 0) throw this.failure('bootstrap', `${domain} ${path}`, boot);
    const en = await this.ctl('enable', target);
    if (en.code !== 0) throw this.failure('enable', target, en);
    return { definitionPath: path };
  }

  async uninstall(): Promise<{ removed: boolean }> {
    const target = `gui/${this.uid()}/${PLIST_LABEL}`;
    const path = this.plistPath;
    const out = await this.ctl('bootout', target);
    const wasLoaded = out.code === 0;
    if (!wasLoaded && !/not find|no such process|not loaded|could not find/i.test(text(out)) && out.code !== 3 && out.code !== 113) {
      throw this.failure('bootout', target, out);
    }
    let existed = true;
    try {
      await this.deps.fs.access(path);
    } catch {
      existed = false;
    }
    if (existed) await this.deps.fs.rm(path, { force: true });
    return { removed: wasLoaded || existed };
  }

  async inspect(): Promise<BackendInspection> {
    const path = this.plistPath;
    let xml: string;
    try {
      xml = await this.deps.fs.readFile(path, 'utf-8');
    } catch {
      return { registered: false };
    }
    const out: BackendInspection = { registered: true, definitionPath: path };
    const notes: string[] = [];
    const command = parsePlist(xml);
    if (command) out.command = command;
    else notes.push(`Could not parse ProgramArguments from ${path}.`);

    const uid = this.getUid?.();
    if (uid === undefined) {
      notes.push('Cannot determine the current user id; launchd state unknown.');
    } else {
      const domain = `gui/${uid}`;
      const loaded = await this.loadedState(`${domain}/${PLIST_LABEL}`);
      if (loaded === 'unknown') notes.push('Could not read launchd state (launchctl print output unparseable or unavailable).');
      else {
        out.active = loaded === 'running';
        if (loaded === 'absent') notes.push(LOGIN_ITEMS_NOTE);
      }
      const disabled = await this.disabledState(domain);
      if (disabled !== undefined) out.enabledInManager = !disabled;
    }
    if (notes.length > 0) out.notes = notes;
    return out;
  }

  /** `print` is "NOT API": parse only `state =` / `pid =`, tolerate anything else. */
  private async loadedState(target: string): Promise<'running' | 'idle' | 'absent' | 'unknown'> {
    try {
      const r = await this.ctl('print', target);
      if (r.code !== 0) return 'absent';
      const state = /^\s*state\s*=\s*(.+?)\s*$/m.exec(r.stdout)?.[1];
      const pid = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(r.stdout)?.[1];
      if (pid !== undefined && Number(pid) > 0) return 'running';
      if (state === 'running') return 'running';
      if (state !== undefined) return 'idle';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** `undefined` when the disable database cannot be read. */
  private async disabledState(domain: string): Promise<boolean | undefined> {
    try {
      const r = await this.ctl('print-disabled', domain);
      return r.code === 0 ? DISABLED_RE.test(r.stdout) : undefined;
    } catch {
      return undefined;
    }
  }

  private async isDisabled(domain: string): Promise<boolean> {
    return (await this.disabledState(domain)) === true;
  }

  private failure(verb: string, what: string, r: { code: number; stderr: string; stdout: string }): CrontickError {
    return new CrontickError('AUTOSTART_FAILED', `launchctl ${verb} ${what} failed (exit ${r.code}): ${text(r)}`);
  }
}
