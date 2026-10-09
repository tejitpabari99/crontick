---
"crontick": minor
---

Add `crontick daemon pause` / `daemon resume` (client `daemonPause`/`daemonResume`, MCP `crontick_daemon_pause`/`crontick_daemon_resume`, `POST /api/daemon/pause|resume`). While paused the daemon stays up but starts no new runs; fires due while paused are recorded as `skipped`. `daemon status` reports `paused`. Paused state is not persisted across restart.
