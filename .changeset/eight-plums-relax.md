---
"crontick": minor
---

An orphaned run (one left `running`/`queued` because the daemon that started it is no longer
live) records a structured `error` on its run row: a message prefixed `"DAEMON_RESTART: "` (e.g.
`"DAEMON_RESTART: run was canceled because the daemon restarted while it was queued or running"`),
keyed by the stable code `ORPHAN_RUN_ERROR_CODE` (`"DAEMON_RESTART"`) rather than an ad hoc string.
Match on the `DAEMON_RESTART:` prefix (or the exported error code) if you need to detect this case
programmatically.
