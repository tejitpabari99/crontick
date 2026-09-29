---
"crontick": minor
---

CLI review fixes:

- `jobs new` help: options ordered name, prompt, schedule flags, then the rest; states that exactly one of `--cron`/`--every`/`--at` is allowed; accurate `--at` (ISO-8601, local timezone unless an offset is given), `--every` (seconds or s/m/h/d suffix) and `--session-id` text. "alias" wording is now "name" in CLI help, MCP descriptions and docs.
- New top-level `crontick daemon start [--foreground]|stop|restart|status|reload` and `crontick doctor` (`info daemon ...` and `info doctor` remain as hidden aliases). `crontick info` now lists the available commands and reports whether the config file exists (`configExists`); `doctor` shows the data dir and config file state. The `daemon-stop`, `daemon-reload` and `doctor` surface entries now point at the new command paths.
- Fix: a Claude run that reports an error (`result` with `is_error`, or a 401 authentication error) and then hangs no longer stays `running`. The run is failed immediately with the parsed error, the process tree is terminated (taskkill /T /F or process-group kill, then force-kill), the active-run lock is released so the next tick is not `skipped`, authentication failures are not retried, and timeouts/cancels/exit-without-close always finalize.
- `jobs run-now` is documented and tested as running a job once even when disabled, without enabling it or changing its schedule (overlap still applies); the daemon accepts `POST /api/jobs/:id/run-now` (alias of `/run`).
- Stats: `avgDurationSec` added to `statsSummary`, the dashboard stats and per-job stats (`avgDurationMs` kept for compatibility).
- `crontick runs list` prints a table with local ISO times, durations in seconds and truncated errors; `--json` prints the raw records.
- New capability `run-output`: `getOutput(runId)`, `crontick runs output <runId> [--json]`, MCP tool `crontick_run_output`, and `GET /api/runs/:id/output` return a cleaned view (final result, error, readable transcript) without thinking signatures or hook payloads. The raw log is unchanged.
