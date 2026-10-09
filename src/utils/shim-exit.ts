import { constants } from 'node:os';

/**
 * Exit code for the sqlite re-exec shim given how the real daemon child ended. A child killed by a
 * signal other than the forwarded SIGTERM/SIGINT (OOM SIGKILL, SIGSEGV) must exit non-zero
 * (128+signum) so `Restart=on-failure` supervisors restart it; a graceful signal stop stays 0.
 */
export function shimExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal === null || signal === 'SIGTERM' || signal === 'SIGINT') return 0;
  return 128 + (constants.signals[signal] ?? 1);
}
