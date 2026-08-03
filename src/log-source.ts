/**
 * Canonical definition of the log-source filter accepted by `getLogs`.
 *
 * This is the single source of truth consumed by the core client (validation),
 * the MCP tool schema, and the daemon store/API (defensive normalization). It
 * is intentionally dependency-free so every layer can import it without risking
 * a circular dependency.
 */

/** Valid `source` filters accepted by getLogs (see docs/reference/cli.md `runs logs`). */
export const LOG_SOURCES = ['all', 'engine', 'crontick'] as const;
export type LogSource = (typeof LOG_SOURCES)[number];
