import { LaunchdBackend } from './launchd.js';
import { SchtasksBackend } from './schtasks.js';
import { SystemdBackend } from './systemd.js';
import type { AutostartBackend, AutostartDeps } from './types.js';

export type BackendFactory = (deps: AutostartDeps) => AutostartBackend;

/** Per-platform backend constructors. Linux, macOS and Windows are registered. */
const DEFAULT_FACTORIES: Partial<Record<NodeJS.Platform, BackendFactory>> = {
  linux: (deps) => new SystemdBackend(deps),
  darwin: (deps) => new LaunchdBackend(deps),
  win32: (deps) => new SchtasksBackend(deps),
};

/** Returns the backend for `deps.platform`, or `undefined` when unsupported. */
export function createAutostartBackend(
  deps: AutostartDeps,
  factories: Partial<Record<NodeJS.Platform, BackendFactory>> = DEFAULT_FACTORIES,
): AutostartBackend | undefined {
  const make = factories[deps.platform];
  return make ? make(deps) : undefined;
}

export { defaultAutostartDeps } from './defaults.js';
export { AutostartService } from './service.js';
export type { AutostartServiceOptions } from './service.js';
export type * from './types.js';
