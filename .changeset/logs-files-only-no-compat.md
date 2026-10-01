---
"crontick": minor
---

crontick now stores only its own logs. The engine's raw stdout/stderr is no longer
written to the database (the `run_logs` table, the `/api/runs/:id/logs` and
`/logs/stream` routes and the SSE stream are gone); only the parsed output (final
answer, error, capped stderr) is kept with each run. crontick-side lifecycle
events go to one per-job log file, and `runs get`, the dashboard run detail and
`GET /api/runs/:id/output` show only that file's absolute path (`logFile`;
the dashboard shows it as plain text with a Copy button, not a link, and never inlines contents).

Total run counts are removed from `stats summary`, `stats job` and the dashboard
(`totalRuns`).

**Breaking (pre-1.0):** all legacy and backward-compatibility code is removed,
including `avgDurationMs` (use `avgDurationSec`), the startup purge of orphaned
runs left by older versions and unsupported older database layouts. A `tz` in an
already-stored job file is silently ignored (no warning is logged); creating or
updating a job with `schedule.tz` is still rejected.
