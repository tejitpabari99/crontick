/**
 * Daemon lifecycle timeouts and poll intervals. Centralized here
 * (design-principles.md #3) so `src/daemon/ensure.ts`, `src/daemon/api.ts`,
 * `src/daemon/runner.ts`, and `src/daemon/lifecycle.ts` share one definition
 * instead of hand-copying the same values.
 */

/** Default max time to wait for a spawned daemon process to come up, in ms (see `ensureDaemon`). */
export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

/** Default max time to wait for a single `/health` probe response, in ms (see `ensureDaemon`). */
export const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;

/** Default max time to wait to acquire the exclusive daemon-start lock, in ms (see `ensureDaemon`). */
export const DEFAULT_LOCK_TIMEOUT_MS = 15_000;

/** Polling interval while waiting for daemon health, lock release, or process exit, in ms. */
export const POLL_MS = 100;

/** Poll interval for SSE log streaming, in ms (see `src/daemon/api.ts`). */
export const SSE_POLL_MS = 200;

/** How often an adopted run's pid is polled for liveness, in ms (see `Runner.adoptRun()`). */
export const ADOPTED_RUN_POLL_MS = 3_000;

/** After an engine reports a terminal error in its output, wait this long for the process to exit on its own before ending the run and killing it. */
export const TERMINAL_ERROR_SETTLE_MS = 2_000;
/** After SIGTERM (timeout, cancel, or terminal engine error), wait this long before force-killing the process tree. */
export const KILL_GRACE_MS = 5_000;
/** After a process exits but its stdio pipes stay open (grandchildren inherited them), finalize the run after this long. */
export const EXIT_CLOSE_GRACE_MS = 3_000;

/**
 * Preferred daemon HTTP port on loopback. Outside the Linux ephemeral range
 * (32768-60999) and IANA-registered services. When taken, the daemon falls back
 * to an OS-assigned free port; clients always discover the real port via `daemon.port`.
 * Override with env `CRONTICK_DAEMON_PORT` (tests).
 */
export const DEFAULT_DAEMON_PORT = 47615;
