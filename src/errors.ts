/** Structured domain error with a machine-readable code and optional details. */
export class CrontickError extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'CrontickError';
    this.code = code;
    this.details = details;
    // Maintain proper prototype chain so `instanceof CrontickError` works after transpilation
    Object.setPrototypeOf(this, CrontickError.prototype);
  }

  toJSON(): { code: string; message: string; details?: unknown } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/**
 * Sentinel value written to the `runs.error` column by
 * Store.reconcileOrphanRuns() when a run left `running`/`queued` after an
 * unclean daemon shutdown is canceled. This is stored SQLite data, not a
 * thrown CrontickError — it follows the `CODE: message` convention already
 * used for other runs.error values (see RUNNER_CALLBACK_FAILED,
 * SESSION_ID_NOT_FOUND, SESSION_PERSIST_FAILED in src/daemon/runner.ts) so
 * programmatic consumers can reliably detect it with a prefix/exact-match
 * check instead of matching an undocumented free-form string.
 */
export const ORPHAN_RUN_ERROR_CODE = 'DAEMON_RESTART';
export const ORPHAN_RUN_ERROR_MESSAGE =
  `${ORPHAN_RUN_ERROR_CODE}: run was canceled because the daemon restarted while it was queued or running`;
