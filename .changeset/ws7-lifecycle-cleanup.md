---
"crontick": patch
---

`crontick daemon status` (and the shared daemon status API/client/MCP result) now includes the daemon's loopback `port` and `baseUrl`, so scripts can discover the active daemon endpoint without reading internal state files.

- `stats summary` and dashboard aggregate/recent-run views now exclude archived runs whose parent job has been deleted. Deleting a job still preserves its historical run/log records for direct run-id lookups.
- Script-job wrapper files now live under the CRONTICK_HOME-managed data directory, are deleted after each run, and daemon startup best-effort sweeps the legacy `%TEMP%\crontick` location left by older builds.
