// Port selection for the daemon HTTP server: prefer a stable port, fall back to
// an OS-assigned free port when it is taken. Listen and probe are injected so the
// policy is unit-testable without real sockets (AGENTS rule 6).
import { DEFAULT_DAEMON_PORT } from '../constants/daemon.js';

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
}

export interface BindPortResult {
  port: number;
  preferred: number;
  fellBack: boolean;
  occupant?: PortOccupant;
  /** The notice that was emitted, when `fellBack`. */
  message?: string;
}

/** Preferred port: `CRONTICK_DAEMON_PORT` (0-65535) when valid, else {@link DEFAULT_DAEMON_PORT}. */
export function preferredDaemonPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['CRONTICK_DAEMON_PORT'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_DAEMON_PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : DEFAULT_DAEMON_PORT;
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

/** Try the preferred port; on EADDRINUSE probe the occupant, notify, and bind an OS-assigned port. */
export async function bindPort(preferred: number, deps: BindPortDeps): Promise<BindPortResult> {
  try {
    const port = await deps.listen(preferred);
    return { port, preferred, fellBack: false };
  } catch (err) {
    if (preferred === 0 || (err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw err;
  }
  let occupant: PortOccupant;
  try {
    occupant = await deps.probe(preferred);
  } catch {
    occupant = { kind: 'foreign' };
  }
  const message = formatPortFallbackMessage(preferred, occupant);
  deps.notify(message);
  const port = await deps.listen(0);
  return { port, preferred, fellBack: true, occupant, message };
}
