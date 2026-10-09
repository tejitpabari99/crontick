import { posix, win32 } from 'node:path';
import { SUPERVISED_ENV } from '../constants/daemon.js';
import { CrontickError } from '../errors.js';
import type {
  AutostartBackend,
  AutostartDeps,
  AutostartDisableResult,
  AutostartEnableResult,
  AutostartSpec,
  AutostartStatus,
  BackendInspection,
} from './types.js';

export interface AutostartServiceOptions {
  deps: AutostartDeps;
  /** Backend for `deps.platform`; `undefined` means unsupported. */
  backend: AutostartBackend | undefined;
  nodePath: string;
  daemonScript: string;
  cliScript: string;
}

const RERUN_HINT = 'Re-run `crontick autostart enable` to refresh the registration.';
const PATH_HINT = 'PATH was captured when autostart was enabled; re-run `crontick autostart enable` after installing engines or changing PATH.';

function isEphemeralPath(p: string): boolean {
  return p.split(/[\\/]+/).includes('_npx');
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Shared autostart logic: spec building, availability, error mapping, drift. Backends only install/uninstall/inspect. */
export class AutostartService {
  constructor(private readonly o: AutostartServiceOptions) {}

  buildSpec(): AutostartSpec {
    const { env } = this.o.deps;
    const out: Record<string, string> = { [SUPERVISED_ENV]: '1' };
    // A relative home would resolve against the manager's cwd at login (a different data dir): pin it absolute.
    const home = env['CRONTICK_HOME'];
    if (home) {
      const p = this.o.deps.platform === 'win32' ? win32 : posix;
      out['CRONTICK_HOME'] = p.isAbsolute(home) ? home : p.resolve(process.cwd(), home);
    }
    if (env['PATH']) out['PATH'] = env['PATH'];
    return {
      nodePath: this.o.nodePath,
      daemonScript: this.o.daemonScript,
      cliScript: this.o.cliScript,
      env: out,
    };
  }

  private unsupportedReason(): string {
    return `Autostart is not supported on platform '${this.o.deps.platform}'.`;
  }

  async status(): Promise<AutostartStatus> {
    const base: AutostartStatus = { supported: false, enabled: false, stale: false, staleReasons: [], hints: [] };
    const backend = this.o.backend;
    if (!backend) return { ...base, reason: this.unsupportedReason() };
    const avail = await this.safeAvailable(backend);
    if (!avail.ok) return { ...base, mechanism: backend.mechanism, reason: avail.reason };
    let inspection: BackendInspection;
    try {
      inspection = await backend.inspect();
    } catch (e) {
      return { ...base, supported: true, mechanism: backend.mechanism, reason: `Could not inspect autostart registration: ${msg(e)}` };
    }
    const enabled = inspection.registered && inspection.enabledInManager !== false;
    const status: AutostartStatus = {
      ...base,
      supported: true,
      enabled,
      mechanism: backend.mechanism,
      hints: [...(inspection.notes ?? [])],
    };
    if (inspection.definitionPath) status.definitionPath = inspection.definitionPath;
    if (inspection.active !== undefined) status.active = inspection.active;
    if (inspection.command) {
      status.command = [inspection.command.nodePath, ...inspection.command.args].join(' ');
    }
    if (inspection.registered && inspection.command) {
      const reasons = this.drift(backend, inspection.command);
      if (reasons.length > 0) {
        status.stale = true;
        status.staleReasons = reasons;
        status.hints.push(RERUN_HINT);
      }
      const registeredPath = inspection.command.env['PATH'];
      if (registeredPath !== undefined && registeredPath !== this.o.deps.env['PATH']) status.hints.push(PATH_HINT);
    }
    return status;
  }

  private drift(backend: AutostartBackend, command: NonNullable<BackendInspection['command']>): string[] {
    const spec = this.buildSpec();
    const reasons: string[] = [];
    if (command.nodePath !== spec.nodePath) {
      reasons.push(`node path changed: registered ${command.nodePath}, current ${spec.nodePath}`);
    }
    const expected = backend.expectedCommand?.(spec) ?? [spec.daemonScript];
    if (!sameList(command.args, expected)) {
      reasons.push(`command changed: registered ${command.args.join(' ')}, expected ${expected.join(' ')}`);
    }
    if (Object.keys(command.env).length > 0) {
      for (const key of ['CRONTICK_HOME', SUPERVISED_ENV]) {
        if (command.env[key] !== spec.env[key]) {
          reasons.push(`${key} changed: registered ${command.env[key] ?? '(unset)'}, current ${spec.env[key] ?? '(unset)'}`);
        }
      }
    }
    return reasons;
  }

  async enable(): Promise<AutostartEnableResult> {
    const backend = this.requireBackend();
    const { daemonScript } = this.o;
    if (isEphemeralPath(daemonScript)) {
      throw new CrontickError(
        'AUTOSTART_EPHEMERAL_PATH',
        `Refusing to enable autostart: the daemon script is in a temporary location (${daemonScript}). Install crontick globally (npm install -g crontick) and run \`crontick autostart enable\` from that install.`,
        { daemonScript },
      );
    }
    try {
      await this.o.deps.fs.access(daemonScript);
    } catch {
      throw new CrontickError(
        'AUTOSTART_SCRIPT_MISSING',
        `Refusing to enable autostart: daemon script not found at ${daemonScript}. Build the project (npm run build) or use an installed package.`,
        { daemonScript },
      );
    }
    await this.requireAvailable(backend);
    try {
      const { definitionPath } = await backend.install(this.buildSpec());
      return { enabled: true, mechanism: backend.mechanism, definitionPath, hints: [PATH_HINT] };
    } catch (e) {
      if (e instanceof CrontickError) throw e;
      throw new CrontickError('AUTOSTART_FAILED', `Failed to enable autostart: ${msg(e)}`);
    }
  }

  async disable(): Promise<AutostartDisableResult> {
    const backend = this.requireBackend();
    await this.requireAvailable(backend);
    try {
      const { removed } = await backend.uninstall();
      return { removed, mechanism: backend.mechanism };
    } catch (e) {
      if (e instanceof CrontickError) throw e;
      throw new CrontickError('AUTOSTART_FAILED', `Failed to disable autostart: ${msg(e)}`);
    }
  }

  private requireBackend(): AutostartBackend {
    if (!this.o.backend) {
      throw new CrontickError(
        'AUTOSTART_UNSUPPORTED',
        `${this.unsupportedReason()} Start the daemon manually with \`crontick daemon start\`.`,
        { platform: this.o.deps.platform },
      );
    }
    return this.o.backend;
  }

  private async safeAvailable(backend: AutostartBackend): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      return await backend.available();
    } catch (e) {
      return { ok: false, reason: msg(e) };
    }
  }

  private async requireAvailable(backend: AutostartBackend): Promise<void> {
    const avail = await this.safeAvailable(backend);
    if (!avail.ok) {
      throw new CrontickError('AUTOSTART_UNAVAILABLE', `Autostart is unavailable: ${avail.reason}`, { mechanism: backend.mechanism });
    }
  }
}
