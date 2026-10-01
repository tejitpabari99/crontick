/**
 * Canonical definition of the log-source filter accepted by `Store.getLogs` and `GET /api/runs/:id/logs`.
 *
 * This is the single source of truth consumed by the daemon store/API
 * (defensive normalization). It is intentionally dependency-free so every layer can import it without risking
 * a circular dependency.
 */

/** Valid `source` filters accepted by the daemon's run-log route. */
export const LOG_SOURCES = ['all', 'engine', 'crontick'] as const;
export type LogSource = (typeof LOG_SOURCES)[number];
