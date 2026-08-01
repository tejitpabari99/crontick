// reporter.mjs — console output + JSON summary writer

/**
 * Creates a new reporter instance for a harness run.
 * @param {{ logDir: string; packageVersion: string; jsonToStdout: boolean }} opts
 * @returns {Reporter}
 */
export function createReporter(opts) {
  // TODO(A4): implement
  void opts;
  throw new Error('createReporter: not implemented');
}

/**
 * @typedef {object} Reporter
 * @property {(result: TestResult) => void} record
 * @property {() => Promise<void>} flush
 */

/**
 * @typedef {object} TestResult
 * @property {number} seq
 * @property {string} id
 * @property {string} title
 * @property {string} area
 * @property {string[]} surface
 * @property {string} tier
 * @property {'pass'|'fail'|'known-fail'|'unexpected-pass'|'skipped'} status
 * @property {number} durationMs
 * @property {{ type: string; status: 'pass'|'fail'; message?: string }[]} checks
 * @property {string|null} knownDefect
 * @property {string|null} errorMessage
 */
