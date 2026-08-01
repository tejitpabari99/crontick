// setup.mjs — build+pack+install orchestrator

/**
 * Runs global setup: optionally builds, packs, and installs crontick into
 * .e2e-scratch/, then resolves bin paths and verifies the installed version.
 *
 * @param {{ repoRoot: string; scratchDir: string; packageVersion: string; forceBuild?: boolean }} opts
 * @returns {Promise<SetupContext>}
 */
export async function runSetup(opts) {
  // TODO(A3): implement (mirrors scripts/verify-package-install.mjs)
  void opts;
  throw new Error('runSetup: not implemented');
}

/**
 * @typedef {object} SetupContext
 * @property {string} scratchDir
 * @property {{ crontick: string; daemon: string; mcp: string }} bins
 * @property {string} packageVersion
 */
