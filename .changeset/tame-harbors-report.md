---
"crontick": major
---

Daemon reliability and observability for v1.0.0:

- **Graceful shutdown works the same on every platform.** `crontick daemon stop` (and the
  underlying `POST /api/daemon/stop` HTTP route) shuts the daemon down in-process and responds to
  the caller only after the response has been sent, reporting `mode: "graceful"` when this
  succeeds. A direct process signal (`SIGTERM`/`SIGINT`) remains a POSIX-only fallback for when the
  daemon's HTTP listener itself is unreachable, reported as `mode: "hard-kill"`.
- **Missed fires are recorded, not silently lost.** On startup, the daemon computes every
  scheduled fire that occurred while it was not running and records each as a terminal run with
  status `missed` (capped at 500 per job), summarized in `crontick daemon status` as
  `{ jobsWithMissedFires, missedRunsRecorded, jobsCapped, capPerJob }`. Missed fires are reported,
  never replayed.
- **Runs survive a daemon restart.** A run still in progress when the daemon restarts is adopted
  back into the runner rather than forgotten, so `overlap: "skip"` and `overlap:
  "cancel-previous"` continue to hold for that job's next tick.
- **Orphan reconciliation checks real process liveness.** A run left `running` after an unclean
  shutdown is checked against its recorded `pid` and start time (guarding against pid reuse)
  before being canceled; a run confirmed still alive, or one that can't be conclusively checked, is
  adopted instead of canceled.
- **Captured run output is bounded.** Per-run stdout/stderr capture stops at
  `retention.maxOutputBytesPerRun` (default 2,000,000 bytes, range 1024..1e9), leaving a truncation
  marker and `outputTruncated: true` on the run. The job's process itself is never affected by
  hitting this cap -- only capture stops.
- **`--exec` takes its command and arguments verbatim.** Arguments after `--` are passed through
  exactly as given, so an argument containing a space no longer needs a workaround. See
  `docs/reference/cli.md` for the two Windows/npm shim behaviors to be aware of when using `--`
  from a `.ps1` or `.cmd` shim.
- **Run history round-trips through export/import.** `crontick export --include-runs` (and
  `includeRuns` on the library/MCP export call) captures run history alongside job definitions, and
  `crontick import` restores it -- the mitigation for taking a snapshot before the retention cap
  evicts older runs.
- **Child processes are spawned detached identically on every platform**, so a daemon restart or
  stop never kills in-flight job work as a side effect on any OS.
- **`runs list --status`** (and `crontick_run_list.status`) filters run history by status, and
  `pid`/`outputTruncated` are exposed on run records.

See the new architecture decision records (ADR 0014-0018) for the reasoning and honest trade-offs
behind each of these.
