---
"crontick": minor
---

Dashboard polish and a stable daemon port. The daemon now prefers port 47615 (env `CRONTICK_DAEMON_PORT` overrides) and, when it is taken, prints whether another crontick daemon or another process holds it and starts on a free port; `daemon start`/`restart`, `daemon status` (`portNote`, `dashboardUrl`), `info` and `doctor` ("daemon port" check) report fallback ports, and `daemon.port` always holds the real port. Run output is now assistant text only, with `---` between segments split by tool calls (no `[tool]` lines). New `GET /api/runs/:id/log/raw` serves a run's redacted raw log and `/api/runs/:id/output` returns `rawLogPath`. Dashboard: icon-only theme switcher, aligned row-action icons, run modal shows the raw log path plus an Open link instead of inlining the log, "Runner Session ID" label, full job ids, "Alias" term, and the job working directory in the drawer and search.
