---
"crontick": patch
---

Fix Copilot session-id capture and add full per-job logging.

- Session-id extraction now matches the Copilot CLI's real `--resume=<uuid>` stats-footer form (and `--session-id=`/`--session-id <id>`), so `reuseSession` jobs no longer fail with `SESSION_ID_NOT_FOUND` when the id is present in the transcript.
- The extracted (or explicitly provided) session id is now persisted on the run record and surfaced via `runs get`, the logs API, and the dashboard run data model (`sessionId`).
- Runs now emit crontick-side lifecycle events (run started, executing, run finished, skips, retries, session captured) on a dedicated `crontick` log stream, in addition to engine `stdout`/`stderr`. Log retrieval accepts a `source` filter (`all` | `engine` | `crontick`) across the client, MCP tool (`crontick_run_logs_tail`), daemon `/api/runs/:id/logs` route, and the CLI `logs --source` flag.
- Every run's logs are additionally mirrored to a best-effort per-job log file at `<dataDir>/logs/<jobId>.log`. New `logging` config (`logging.fileEnabled`, `logging.dir`) controls this; file writes never block or fail a run.
