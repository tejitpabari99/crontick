/**
 * Retention defaults for stored runs, per-run output capture, and daemon log
 * files. Centralized here (design-principles.md #3) so the built-in config
 * (`src/config.ts`), its schema (`src/schemas/config.ts`), the run store
 * (`src/daemon/store.ts`), and the runner's output-cap fallback
 * (`src/daemon/runner.ts`) share one definition instead of hand-copying the
 * same literals.
 */

/** Default `retention.maxRunsPerJob`: how many runs are kept per job before the oldest are pruned. */
export const DEFAULT_RUN_RETENTION_CAP = 100;

/**
 * Default `retention.maxOutputBytesPerRun`: bytes of plain stdout captured per run
 * (text/raw engines) before further stdout is dropped. It does not cap stderr
 * (see `DEFAULT_MAX_STDERR_BYTES_PER_RUN`) and Claude stream-json stdout is
 * trimmed to the final result event instead.
 */
export const DEFAULT_MAX_OUTPUT_BYTES_PER_RUN = 2_000_000;

/**
 * Fixed per-run stderr capture cap (not configurable): stderr bytes kept before
 * further stderr is dropped and a truncation marker is appended. Applies to all engines.
 */
export const DEFAULT_MAX_STDERR_BYTES_PER_RUN = 1_000_000;

/** Default `retention.maxLogFiles`: how many daily `daemon-YYYY-MM-DD.log` files are kept before the oldest are deleted. */
export const DEFAULT_MAX_LOG_FILES = 30;
