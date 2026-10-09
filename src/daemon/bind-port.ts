// Port selection for the daemon HTTP server: prefer a stable port, fall back to
// an OS-assigned free port when it is taken. Listen and probe are injected so the
// policy is unit-testable without real sockets (AGENTS rule 6).
import { DEFAULT_DAEMON_PORT } from '../constants/daemon.js';
import { CrontickError } from '../errors.js';
import type { CrontickConfig } from '../schemas/config.js';

/** Who is holding the preferred port. */
export type PortOccupant =
  | { kind: 'crontick'; pid?: number; dataDir?: string }
  | { kind: 'foreign' };

export interface BindPortDeps {
  /** Bind the server on loopback; resolves with the actual port, rejects with the listen error (carrying `code`). */
  listen(port: number): Promise<number>;
  /** Identify whatever is listening on `port` (crontick health signature or not). */
  probe(port: number): Promise<PortOccupant>;
  /** Called once with the human-readable fallback notice. */
  notify(message: string): void;
  /** Path of config.json, named in explicit-port errors. */
  configPath: string;
  /** This daemon's data dir, to recognize a crontick occupant of the same data dir. */
  dataDir: string;
}

/** Resolved port preference: `explicit` means `daemon.port` is set in config. */
export interface PreferredPort {
  port: number;
  explicit: boolean;
}

export interface BindPortResult {
  port: number;
  preferred: number;
  fellBack: boolean;
  occupant?: PortOccupant;
  /** The notice that was emitted, when `fellBack`. */
  message?: string;
}

/** Preferred port from config: `daemon.port` when set (explicit), else {@link DEFAULT_DAEMON_PORT}. */
export function preferredDaemonPort(config: Pick<CrontickConfig, 'daemon'>): PreferredPort {
  const port = config.daemon?.port;
  return port === undefined ? { port: DEFAULT_DAEMON_PORT, explicit: false } : { port, explicit: true };
}

/**
 * Note for a daemon bound to a port other than the preferred one (`null` when it is the preferred port).
 * Shown by `daemon start`/`restart`, `daemon status`, `info`, and `doctor`.
 */
export function describeDaemonPort(
  port: number | undefined,
  config: Pick<CrontickConfig, 'daemon'> = { daemon: {} },
): string | null {
  const pref = preferredDaemonPort(config);
  if (port === undefined || pref.explicit || port === pref.port) return null;
  return `started on fallback port ${port}; default ${pref.port} is in use`;
}

/** Human-readable notice for a taken preferred port. */
export function formatPortFallbackMessage(preferred: number, occupant: PortOccupant): string {
  if (occupant.kind === 'crontick') {
    const pid = occupant.pid === undefined ? 'unknown' : String(occupant.pid);
    const dir = occupant.dataDir ?? 'unknown';
    return `Port ${preferred} is in use by another crontick daemon (pid ${pid}, data dir ${dir}); starting on a free port`;
  }
  return `Port ${preferred} is in use by another process (not crontick); starting on a free port`;
}

/** Message for an explicit `daemon.port` held by another listener. */
export function formatPortInUseMessage(port: number, occupant: PortOccupant, configPath: string, ownDataDir?: string): string {
  if (occupant.kind === 'crontick') {
    const pid = occupant.pid === undefined ? 'unknown' : String(occupant.pid);
    if (ownDataDir !== undefined && occupant.dataDir === ownDataDir) {
      return `Port ${port} (config daemon.port) is held by a crontick daemon for this data dir (pid ${pid}); run \`crontick daemon stop\``;
    }
    return `Port ${port} (config daemon.port) is in use by another crontick daemon (pid ${pid}, data dir ${occupant.dataDir ?? 'unknown'}); free it or change daemon.port in ${configPath}`;
  }
  return `Port ${port} (config daemon.port) is in use by another process (not crontick); free it or change daemon.port in ${configPath}`;
}

/**
 * Bind per the preference. Unset: try the default port; on EADDRINUSE probe the
 * occupant, notify, and bind an OS-assigned port. Explicit non-zero: on
 * EADDRINUSE throw DAEMON_PORT_IN_USE (no fallback). Explicit 0: OS-assigned.
 */
export async function bindPort(pref: PreferredPort, deps: BindPortDeps): Promise<BindPortResult> {
  const preferred = pref.port;
  try {
    const port = await deps.listen(preferred);
    return { port, preferred, fellBack: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (preferred === 0 || code !== 'EADDRINUSE') {
      if (pref.explicit && preferred !== 0 && err instanceof Error) {
        err.message = `${err.message} (port ${preferred}, config daemon.port in ${deps.configPath})`;
      }
      throw err;
    }
  }
  let occupant: PortOccupant;
  try {
    occupant = await deps.probe(preferred);
  } catch {
    occupant = { kind: 'foreign' };
  }
  if (pref.explicit) {
    throw new CrontickError(
      'DAEMON_PORT_IN_USE',
      formatPortInUseMessage(preferred, occupant, deps.configPath, deps.dataDir),
      { port: preferred, occupant, configPath: deps.configPath },
    );
  }
  const message = formatPortFallbackMessage(preferred, occupant);
  deps.notify(message);
  const port = await deps.listen(0);
  return { port, preferred, fellBack: true, occupant, message };
}
