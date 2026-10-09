import type { AutostartBackend, AutostartDeps } from './types.js';

export type BackendFactory = (deps: AutostartDeps) => AutostartBackend;

/** Per-platform backend constructors. Linux is registered by the systemd backend task; macOS/Windows by their sub-projects. */
const DEFAULT_FACTORIES: Partial<Record<NodeJS.Platform, BackendFactory>> = {};

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
