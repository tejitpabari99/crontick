---
'crontick': minor
---

CLI and job model overhaul (pre-1.0, breaking changes in a minor):

- One user-facing term, **alias** (`--alias`/`-a` sets it); every command and MCP tool that takes a job accepts an id or an alias. Alias generation falls back to a random suffix after many collisions and retries create races. `jobs new`/`jobs update` share one option list (`-p`, `-a`, `-C`).
- Per-job working directory (`--cwd`/`-C`, `action.cwd`, defaults to the invoking directory) plus a Claude folder-trust check: `TRUST_REQUIRED`, an interactive y/N prompt, `--trust-folder` / `trustFolder`, `CWD_CHANGE_BREAKS_SESSION`.
- `config.json` is created automatically with the full defaults (never overwritten); `crontick info` no longer lists commands and the hidden `info daemon` / `info doctor` aliases are removed.
- BREAKING: `--tz` / `schedule.tz` removed (cron fires in machine local time; a `tz` in an already-stored job file is silently ignored).
- BREAKING: deleting a job now deletes its runs, logs and schedule state (orphans are purged at daemon start); `jobs delete` reports `deletedRuns`.
- BREAKING: `runs logs`, `runs output`, `crontick_run_logs_tail`, `crontick_run_output` and `CrontickClient.getLogs` (with `LogsResult`, `LogEntry`, `LogSource`, `LOG_SOURCES`) are removed; `runs get` / `crontick_run_get` now show the run, its `logFile` and the cleaned output.
- BREAKING: `share export`/`share import` use a validated `schema: 1` jobs-only file (`--only-jobs`, `.json` suffix appended to `--out`, new ids and alias suffixing on import); `--include-runs` and run import are removed.
- `jobs schedule` shows `status: enabled|disabled`; `stats job` counts all retained runs and prints `lastRunAt` as local ISO-8601.
