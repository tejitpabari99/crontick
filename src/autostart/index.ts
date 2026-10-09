import { LaunchdBackend } from './launchd.js';
import { SystemdBackend } from './systemd.js';
import type { AutostartBackend, AutostartDeps } from './types.js';

export type BackendFactory = (deps: AutostartDeps) => AutostartBackend;

/** Per-platform backend constructors. Linux and macOS are registered; Windows by its sub-project. */
const DEFAULT_FACTORIES: Partial<Record<NodeJS.Platform, BackendFactory>> = {
  linux: (deps) => new SystemdBackend(deps),
  darwin: (deps) => new LaunchdBackend(deps),
};

/** Returns the backend for `deps.platform`, or `undefined` when unsupported. */
export function createAutostartBackend(
  deps: AutostartDeps,
  factories: Partial<Record<NodeJS.Platform, BackendFactory>> = DEFAULT_FACTORIES,
): AutostartBackend | undefined {
  const make = factories[deps.platform];
  return make ? make(deps) : undefined;
}

export { AutostartService } from './service.js';
export type { AutostartServiceOptions } from './service.js';
export type * from './types.js';
