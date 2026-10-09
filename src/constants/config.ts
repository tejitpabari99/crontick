/** Constants shared by the config write path, surfaces and tests. */

/** Notice returned by every successful config write on every surface. */
export const CONFIG_EDIT_NOTICE =
  'Saved. Running runs are not affected. Default changes apply to new jobs only. Engine changes apply on the next run. `daemon.port` needs a restart.';

/** Placeholder that replaces secret values on every config read (matches `redactValue`). */
export const CONFIG_REDACTED_MARKER = '[REDACTED]';

/** Sentinel returned by `getConfigRevision` when no config file exists. */
export const CONFIG_REVISION_ABSENT = 'absent';

/** Config write lock: retry window and age after which a lock is considered stale. */
export const CONFIG_LOCK_TIMEOUT_MS = 2_000;
export const CONFIG_LOCK_STALE_MS = 10_000;
export const CONFIG_LOCK_RETRY_MS = 25;

/** Rename-over-existing-file retries (Windows EPERM/EBUSY when another process has the file open). */
export const CONFIG_RENAME_RETRIES = 5;
export const CONFIG_RENAME_RETRY_MS = 20;

/** Marker (under the data dir) written while a wait-then-apply config save is pending; found on startup it means the wait was lost. */
export const PENDING_CONFIG_APPLY_FILE = 'pending-config-apply.json';

/** The two accepted choices when a config save finds runs in flight. */
export const IN_FLIGHT_CHOICES = ['stop', 'wait'] as const;
