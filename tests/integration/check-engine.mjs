// check-engine.mjs — check-type registry + assertion dispatcher

/** Canonical set of all known check type names. */
export const KNOWN_CHECK_TYPES = new Set([
  'exitCodeEquals',
  'stdoutContains',
  'stdoutNotContains',
  'stderrContains',
  'stdoutJsonPathEquals',
  'stdoutJsonArrayLength',
  'apiResultJsonPathEquals',
  'mcpToolResultJsonPath',
  'fileExists',
  'fileNotExists',
  'fileContentEquals',
  'fileContentContains',
  'runStatusEquals',
  'runExitCodeEquals',
  'runErrorMatches',
  'runLogContains',
  'crossSurfaceFieldEquals',
  'stdoutJsonArrayContains',
  'stdoutJsonArrayNotContains',
  'daemonHealthOk',
]);

/**
 * Runs a single check against the results map.
 *
 * @param {object} check - The check entry from tests.json
 * @param {Map<string, object>} invocationResults - Map from invocationRef → result
 * @param {object} ctx - Run context ({ testHome, scratchDir, cliDriver })
 * @returns {Promise<void>} Resolves on pass; throws with a descriptive message on failure.
 */
export async function runCheck(check, invocationResults, ctx) {
  // TODO(A4): implement all check types listed in KNOWN_CHECK_TYPES
  void check;
  void invocationResults;
  void ctx;
  throw new Error('runCheck: not implemented');
}
