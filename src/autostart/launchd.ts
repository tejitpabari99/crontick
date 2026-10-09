import { dirname, join } from 'node:path';
import { CrontickError } from '../errors.js';
import { PLIST_LABEL, plistPaths, renderPlist } from './plist.js';
import type { AutostartBackend, AutostartDeps, AutostartSpec, BackendInspection } from './types.js';

const LAUNCHCTL = '/bin/launchctl';

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

  // TODO(SP08 Task 3): real inspect (plist parse, launchctl print / print-disabled). Minimal stub for the interface.
  async inspect(): Promise<BackendInspection> {
    return { registered: false };
  }

  private async isDisabled(domain: string): Promise<boolean> {
    try {
      const r = await this.ctl('print-disabled', domain);
      if (r.code !== 0) return false;
      return new RegExp(`"${PLIST_LABEL.replace(/\./g, '\\.')}"\\s*=>\\s*(disabled|true)`).test(r.stdout);
    } catch {
      return false;
    }
  }

  private failure(verb: string, what: string, r: { code: number; stderr: string; stdout: string }): CrontickError {
    return new CrontickError('AUTOSTART_FAILED', `launchctl ${verb} ${what} failed (exit ${r.code}): ${text(r)}`);
  }
}
