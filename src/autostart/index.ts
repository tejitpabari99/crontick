/**
 * Autostart abstraction — factory + types.
 * v1: win32 (HKCU Run + VBS shim) and manual (prints instructions).
 * darwin/linux are stubs that throw NotImplementedInV1Error.
 */
import { Win32Autostart } from './win32.js';
import { ManualAutostart } from './manual.js';
import { DarwinAutostart } from './darwin.js';
import { LinuxAutostart } from './linux.js';

export type AutostartBackend = 'win32' | 'darwin' | 'linux' | 'manual';

export interface AutostartStatus {
  installed: boolean;
  backend: AutostartBackend;
  details?: unknown;
}

export interface Autostart {
  install(): Promise<{ ok: true }>;
  remove(): Promise<{ ok: true }>;
  status(): Promise<AutostartStatus>;
}

/** Thrown by darwin/linux stubs; serialised as HTTP 501 by the daemon API. */
export class NotImplementedInV1Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedInV1Error';
    Object.setPrototypeOf(this, NotImplementedInV1Error.prototype);
  }
}

/**
 * Factory: default = win32 on Windows, manual everywhere else.
 * An explicit `opts.backend` always overrides the default.
 */
export function createAutostart(opts?: { backend?: AutostartBackend }): Autostart {
  const backend: AutostartBackend =
    opts?.backend ?? (process.platform === 'win32' ? 'win32' : 'manual');
  switch (backend) {
    case 'win32':   return new Win32Autostart();
    case 'darwin':  return new DarwinAutostart();
    case 'linux':   return new LinuxAutostart();
    case 'manual':
    default:        return new ManualAutostart();
  }
}
