import { posix } from 'node:path';
import type { AutostartBackend, AutostartDeps, AutostartSpec, BackendInspection } from './types.js';
import { parseUnit, renderUnit } from './unit.js';

const UNIT_NAME = 'crontick.service';
const LINGER_HINT =
  'systemd stops your user manager at last logout, pausing schedules while fully logged out. Run `loginctl enable-linger` to keep crontick running.';

/** systemd `--user` backend: writes a plain unit file and drives `systemctl --user`. */
export class SystemdBackend implements AutostartBackend {
  readonly mechanism = 'systemd-user' as const;

  constructor(private readonly deps: AutostartDeps) {}

  private get unitPath(): string {
    const xdg = this.deps.env['XDG_CONFIG_HOME'];
    const base = xdg ? xdg : posix.join(this.deps.homedir, '.config');
    return posix.join(base, 'systemd', 'user', UNIT_NAME);
  }

  private ctl(...args: string[]) {
    return this.deps.exec('systemctl', ['--user', ...args]);
  }

  private async ctlOrThrow(...args: string[]): Promise<void> {
    const r = await this.ctl(...args);
    if (r.code !== 0) {
      throw new Error(`systemctl --user ${args.join(' ')} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
    }
  }

  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const r = await this.ctl('show-environment');
      if (r.code === 0) return { ok: true };
      return { ok: false, reason: `systemd user manager is not reachable: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}` };
    } catch (e) {
      return { ok: false, reason: `systemctl is not available: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async install(spec: AutostartSpec): Promise<{ definitionPath: string }> {
    const path = this.unitPath;
    const content = renderUnit(spec);
    let previous: string | undefined;
    try {
      previous = await this.deps.fs.readFile(path, 'utf-8');
    } catch {
      previous = undefined;
    }
    const changed = previous !== content;
    const wasActive = changed && (await this.isActive());
    await this.deps.fs.mkdir(posix.dirname(path), { recursive: true });
    await this.deps.fs.writeFile(path, content, { mode: 0o644 });
    await this.ctlOrThrow('daemon-reload');
    await this.ctlOrThrow('enable', '--now', UNIT_NAME);
    if (wasActive) await this.ctlOrThrow('restart', UNIT_NAME);
    return { definitionPath: path };
  }

  async uninstall(): Promise<{ removed: boolean }> {
    const path = this.unitPath;
    try {
      await this.deps.fs.access(path);
    } catch {
      return { removed: false };
    }
    await this.ctl('disable', '--now', UNIT_NAME);
    await this.deps.fs.rm(path, { force: true });
    await this.ctlOrThrow('daemon-reload');
    return { removed: true };
  }

  async inspect(): Promise<BackendInspection> {
    const path = this.unitPath;
    let text: string;
    try {
      text = await this.deps.fs.readFile(path, 'utf-8');
    } catch {
      return { registered: false };
    }
    const out: BackendInspection = { registered: true, definitionPath: path };
    const command = parseUnit(text);
    if (command) out.command = command;
    else out.notes = [`Could not parse ExecStart from ${path}.`];
    const enabled = await this.ctl('is-enabled', UNIT_NAME);
    out.enabledInManager = enabled.code === 0;
    out.active = await this.isActive();
    const linger = await this.linger();
    if (linger === false) (out.notes ??= []).push(LINGER_HINT);
    return out;
  }

  private async isActive(): Promise<boolean> {
    try {
      const r = await this.ctl('is-active', UNIT_NAME);
      return r.code === 0 && r.stdout.trim() === 'active';
    } catch {
      return false;
    }
  }

  /** `undefined` when unknown (loginctl missing or failing). */
  private async linger(): Promise<boolean | undefined> {
    try {
      const r = await this.deps.exec('loginctl', ['show-user', '-p', 'Linger']);
      if (r.code !== 0) return undefined;
      const m = /Linger=(\w+)/.exec(r.stdout);
      return m ? m[1] === 'yes' : undefined;
    } catch {
      return undefined;
    }
  }
}
