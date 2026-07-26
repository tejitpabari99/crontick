---
"crontick": minor
---

Changed the `error` message stored on `runs` for orphaned runs (a run left `running`/`queued` when
the daemon restarts, then canceled on the next startup). It previously reported the bare string
`"daemon-restart"`; it now reports a descriptive message prefixed with `"DAEMON_RESTART: "` (e.g.
`"DAEMON_RESTART: run was canceled because the daemon restarted while it was queued or running"`).
If you have code that matches the exact previous string, match on the `DAEMON_RESTART:` prefix
instead.
