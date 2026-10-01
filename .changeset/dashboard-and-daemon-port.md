---
"crontick": minor
---

Dashboard polish and a stable daemon port. The daemon now prefers port 47615 (env `CRONTICK_DAEMON_PORT` overrides) and, when it is taken, prints whether another crontick daemon or another process holds it and starts on a free port; `daemon start`/`restart`, `daemon status` (`portNote`, `dashboardUrl`), `info` and `doctor` ("daemon port" check) report fallback ports, and `daemon.port` always holds the real port. Dashboard: icon-only theme switcher, aligned row-action icons, run modal shows the log file path (never inlines the log), "Runner Session ID" label, full job ids, "Alias" term, and the job working directory in the drawer and search.
