# crontick

## 0.3.0

### Minor Changes

- fbbf4c5: Forward unknown long CLI flags from prompt job create and update to the selected engine, and reject crontick-managed `--output-format` and `--settings` arguments at validation time.
- fbbf4c5: Make Claude Code the sole built-in default prompt engine through a typed
  engine-adapter registry, while keeping custom engines on the raw adapter by
  default. Add configurable job defaults for overlap, timeout, and retry.

  **Breaking (pre-1.0):** the built-in Copilot engine is removed. A config that
  still selects Copilot must define it explicitly; jobs needing that engine
  must use a custom raw engine entry. The job CLI uses `--runner` in place
  of `--engine` (`--alias`/`-a` names the job).

  Claude runs pre-assign session IDs, parse structured results, and expose cost,
  turns, redacted usage, transcript path, and engine status through library,
  CLI, and MCP run fields. Run and statistics surfaces also expose `skipped`
  separately from `canceled`, plus aggregate cost and turns. Unrecognized
  long job flags pass through to engine arguments, while crontick-managed
  flags remain reserved.

- fbbf4c5: Store Claude run cost, turns, redacted usage, transcript path, and engine status; expose them through run queries and aggregate cost and turns in statistics.
- fbbf4c5: Claude runs now trim the engine stream as it arrives: only the final `result` event and stderr are kept (no assistant text segments, no line-size limit; stderr is capped at 1,000,000 bytes per run with a truncation marker, for every engine). Only Claude (stream-json) runs are trimmed this way; other engines' stdout is plain output under `retention.maxOutputBytesPerRun`, and the runner warns that it has no adapter support. `RunOutput.output` and the `run_outputs.output`/`truncated` columns are removed. `transcriptPath` honors `CLAUDE_CONFIG_DIR`, is available while the run is in progress, and prefers the path reported by Claude's SessionEnd hook once the run ends.
- fbbf4c5: CLI and job model overhaul (pre-1.0, breaking changes in a minor):

  - One user-facing term, **alias** (`--alias`/`-a` sets it); every command and MCP tool that takes a job accepts an id or an alias. Alias generation falls back to a random suffix after many collisions and retries create races. `jobs new`/`jobs update` share one option list (`-p`, `-a`, `-C`).
  - Per-job working directory (`--cwd`/`-C`, `action.cwd`, defaults to the invoking directory) plus a Claude folder-trust check: `TRUST_REQUIRED`, an interactive y/N prompt, `--trust-folder` / `trustFolder`, `CWD_CHANGE_BREAKS_SESSION`.
  - `config.json` is created automatically with the full defaults (never overwritten); `crontick info` no longer lists commands and the hidden `info daemon` / `info doctor` aliases are removed.
  - BREAKING: `--tz` / `schedule.tz` removed (cron fires in machine local time; a `tz` in an already-stored job file is silently ignored).
  - BREAKING: deleting a job now deletes its runs, logs and schedule state (orphans are purged at daemon start); `jobs delete` reports `deletedRuns`.
  - BREAKING: `runs logs`, `runs output`, `crontick_run_logs_tail`, `crontick_run_output` and `CrontickClient.getLogs` (with `LogsResult`, `LogEntry`, `LogSource`, `LOG_SOURCES`) are removed; `runs get` / `crontick_run_get` now show the run, its `logFile` and the cleaned output.
  - BREAKING: `share export`/`share import` use a validated `schema: 1` jobs-only file (`--only-jobs`, `.json` suffix appended to `--out`, new ids and alias suffixing on import); `--include-runs` and run import are removed.
  - `jobs schedule` shows `status: enabled|disabled`; `stats job` counts all retained runs and prints `lastRunAt` as local ISO-8601.

- fbbf4c5: CLI review fixes:

  - `jobs new` help: options ordered alias, prompt, schedule flags, then the rest; states that exactly one of `--cron`/`--every`/`--at` is allowed; accurate `--at` (ISO-8601, local timezone unless an offset is given), `--every` (seconds or s/m/h/d suffix) and `--session-id` text.
  - New top-level `crontick daemon start [--foreground]|stop|restart|status|reload` and `crontick doctor` (there is no `info daemon` / `info doctor`). `crontick info` reports whether the config file exists (`configExists`) and does not list commands; `doctor` shows the data dir and config file state. The `daemon-stop`, `daemon-reload` and `doctor` surface entries point at the new command paths.
  - Fix: a Claude run that reports an error (`result` with `is_error`, or a 401 authentication error) and then hangs no longer stays `running`. The run is failed immediately with the parsed error, the process tree is terminated (taskkill /T /F or process-group kill, then force-kill), the active-run lock is released so the next tick is not `skipped`, authentication failures are not retried, and timeouts/cancels/exit-without-close always finalize.
  - `jobs run-now` is documented and tested as running a job once even when disabled, without enabling it or changing its schedule (overlap still applies); the daemon accepts `POST /api/jobs/:id/run-now` (alias of `/run`).
  - Stats: `avgDurationSec` added to `statsSummary`, the dashboard stats and per-job stats (the older `avgDurationMs` is removed).
  - `crontick runs list` prints a table with local ISO times, durations in seconds and truncated errors; `--json` prints the raw records.
  - Cleaned run output: `getOutput(runId)` and `GET /api/runs/:id/output` return the run's final result, error and stderr (no thinking signatures, hook payloads or transcript); `runs get` / `crontick_run_get` show it. There is no separate `runs output` command or `crontick_run_output` tool.
  - Dashboard: auto-refresh selector (Off/10s/15s/30s/60s, remembered in localStorage); run detail shows a status badge in the title and the error above the cleaned output; multi-select job and status filters with removable chips; sortable Job/Status/Started/Duration headers (the Sort dropdown is gone); expanding search for jobs (config text) and runs (including run logs); a job details drawer (config, stats, recent runs, actions); a "Run once now" button per job; durations shown in seconds. `GET /api/runs` and `GET /api/dashboard` accept comma-separated `jobId`/`status` and a `q` search (also `DashboardOptions.jobIds`/`statuses`/`q`).

- fbbf4c5: Dashboard polish and a stable daemon port. The daemon now prefers port 47615 (env `CRONTICK_DAEMON_PORT` overrides) and, when it is taken, prints whether another crontick daemon or another process holds it and starts on a free port; `daemon start`/`restart`, `daemon status` (`portNote`, `dashboardUrl`), `info` and `doctor` ("daemon port" check) report fallback ports, and `daemon.port` always holds the real port. Dashboard: icon-only theme switcher, aligned row-action icons, run modal shows the log file path (never inlines the log), "Runner Session ID" label, full job ids, "Alias" term, and the job working directory in the drawer and search.
- fbbf4c5: Add a System / Light / Dark theme toggle to the dashboard. Colors are now CSS custom properties, the choice is persisted in `localStorage`, and the saved theme is applied before first paint.
- fbbf4c5: Add an optional engine `type` discriminator to config. Existing engines default to `raw`; the `claude` type is accepted for the Claude adapter implementation.
- fbbf4c5: Replace the Claude SessionEnd base64/eval hook with a plain helper script (`<dataDir>/hooks/session-end.cjs`), show `--settings <session-end-hook>` in stored commands, expose `logFile` on run get, and add display-only `usage` (normalized token counts) to run output.
- fbbf4c5: crontick now stores only its own logs. The engine's raw stdout/stderr is no longer
  written to the database (the `run_logs` table, the `/api/runs/:id/logs` and
  `/logs/stream` routes and the SSE stream are gone); only the parsed output (final
  answer, error, capped stderr) is kept with each run. crontick-side lifecycle
  events go to one per-job log file, and `runs get`, the dashboard run detail and
  `GET /api/runs/:id/output` show only that file's absolute path (`logFile`;
  the dashboard shows it as plain text with a Copy button, not a link, and never inlines contents).

  Total run counts are removed from `stats summary`, `stats job` and the dashboard
  (`totalRuns`).

  **Breaking (pre-1.0):** all legacy and backward-compatibility code is removed,
  including `avgDurationMs` (use `avgDurationSec`), the startup purge of orphaned
  runs left by older versions and unsupported older database layouts. A `tz` in an
  already-stored job file is silently ignored (no warning is logged); creating or
  updating a job with `schedule.tz` is still rejected.

- fbbf4c5: **Breaking:** crontick is now prompt-only. The `script` and `exec` job action kinds are removed -- every job's `action.kind` must be `"prompt"`. Existing jobs using `kind: "script"` or `kind: "exec"` will be rejected by validation on next create/update and must be migrated by hand to a prompt action. The `--script`/`--exec`/`--shell` CLI flags, the corresponding MCP validation branches, and all script/exec runner internals (temp-file/shell handling, the PowerShell exit/UTF-8 wrapper) are removed. The Copilot marketplace plugin (`plugin/`) and this repo's Copilot-specific `.github/skills/` are also removed from this branch (preserved on `users/tejitpabari/copilot-init`); the bundled `src/skill/SKILL.md` is now engine-neutral. Session-ID capture (`extractSessionId`) drops the Copilot-specific `--resume=<uuid>` pattern in favor of a minimal generic fallback (`--session-id=<id>`, `session id: <id>`). See ADR 0002 for the full rationale.
- fbbf4c5: Job CLI flags: `jobs new` and `jobs update` rename `--engine` to `--runner` and add `-a` as the short form of `--alias` (the alias flag keeps its name). The old `--engine` switch now fails as an unknown option, including through engine-argument passthrough. CLI `--every` also accepts `s`, `m`, `h`, and `d` duration suffixes while bare numbers remain seconds.
- fbbf4c5: Run detail shows the final answer, error and stderr plus the full log file and Claude transcript paths as plain text (dashboard with Copy buttons, `runs get` as labelled lines). A path whose file is missing is flagged `file not found`; `getRun` / `GET /api/runs/:id` gain `logFileExists` and `transcriptExists`.
- fbbf4c5: Record overlap skips as `skipped`, expose separate skipped and canceled statistics, and require `overlap: skip` for jobs that reuse a session.

### Patch Changes

- fbbf4c5: Record Claude `SessionEnd` completion markers and use valid markers to recover run exit status after a daemon restart.
- fbbf4c5: Fail Claude resume runs before spawning unless a completed prior run and transcript both exist, capture only completed Claude sessions for reuse, and ignore stdin for prompt children.
- fbbf4c5: Safely restart imported Claude sessions without trusting archival run provenance, resolve Windows transcript paths, and account for usage across retries.
- 364cb8e: Running `crontick` with no subcommand now prints help and exits `0` instead of
  `1`. Previously the bare invocation used Commander's default "no command"
  behavior (help to stderr, exit code 1), which PowerShell 7.4+ surfaces as a
  noisy `NativeCommandExitException` on a purely informational invocation.
  `crontick --help` and every subcommand are unchanged.
- 364cb8e: Reorganize the CLI and MCP surfaces around grouped jobs/runs/stats/share commands: config now prints the file path, info reports version/runtime/path status, runs delete removes run history/log rows, and jobs schedule previews existing jobs. The global --json flag and dedicated script/exec/config CLI/MCP exposure were removed while script and exec remain available through job JSON and the core client; CLI errors now render as clean colored single-line messages with verbose diagnostics on request.
- 364cb8e: Remove the `dashboard` CLI command group and `crontick_dashboard_*` MCP tools; the dashboard is always served by the daemon, and `crontick info` (and `crontick_info`) now expose its URL via `dashboardUrl`.
- 364cb8e: Overhaul the dashboard web UI: the jobs table now shows a job `Alias` column and a
  copyable GUID `ID` column (the `Enabled` column is dropped) plus a right-aligned
  actions cell with enable/disable and delete icon buttons (disable and delete prompt
  for confirmation). Clicking a job row filters the runs list to that job. The recent
  runs section gains a server-side "Filter Job" dropdown, a client-side status filter,
  and a time/duration sort control. Run rows now show the full run id and session id
  (each with a copy button) and open a log modal that splits Output (stdout + crontick
  streams) from Error (stderr + the run's recorded error), each independently scrollable.
  The stale `crontick dashboard data --runs-limit` hint in the dashboard runsLimit
  validation errors is replaced with guidance to provide a positive integer.
- 364cb8e: Jobs now have an immutable, server-assigned GUID `id` (`node:crypto` `randomUUID()`) as their internal primary key, plus an optional, user-editable, unique `alias`. Auto-generated when omitted (`<word>-<1-1000>`, retried on collision). Every surface that accepts a job identifier (CLI, MCP, HTTP API) now accepts either the GUID `id` or the `alias` and resolves it internally, returning `JOB_NOT_FOUND` when neither matches. This fixes a bug where deleting a job and recreating it with the same identifier would show the previous job's stale run status/history in the dashboard, since runs are now permanently tied to the GUID rather than a reusable human string. Existing on-disk jobs are migrated in place on daemon startup: their old id becomes the `alias` and a fresh GUID becomes the `id`, with run history remapped to match. The dashboard now exposes both `id` and `alias` for each job (and each run's associated `alias`) without changing any existing fields or the frontend markup.
- 364cb8e: Fix Copilot session-id capture and add full per-job logging.

  - Session-id extraction now matches the Copilot CLI's real `--resume=<uuid>` stats-footer form (and `--session-id=`/`--session-id <id>`), so `reuseSession` jobs no longer fail with `SESSION_ID_NOT_FOUND` when the id is present in the transcript.
  - The extracted (or explicitly provided) session id is now persisted on the run record and surfaced via `runs get`, the logs API, and the dashboard run data model (`sessionId`).
  - Runs now emit crontick-side lifecycle events (run started, executing, run finished, skips, retries, session captured) on a dedicated `crontick` log stream, in addition to engine `stdout`/`stderr`. Log retrieval accepts a `source` filter (`all` | `engine` | `crontick`) across the client, MCP tool (`crontick_run_logs_tail`), daemon `/api/runs/:id/logs` route, and the CLI `logs --source` flag.
  - Every run's logs are additionally mirrored to a best-effort per-job log file at `<dataDir>/logs/<jobId>.log`. New `logging` config (`logging.fileEnabled`, `logging.dir`) controls this; file writes never block or fail a run.

- fbbf4c5: Fix two leftover fallbacks that still defaulted to the removed Copilot engine when a prompt action's engine was unset: the Windows command-line length estimate and the args-only patch runtime validation now fall back to `claude`, the sole remaining built-in engine.
- 364cb8e: docs: rewrite README to foreground crontick's AI-native prompt-job workflow and current command surface
- 364cb8e: Remove pre-production migration, legacy, and back-compatibility code: fold all columns and the alias-uniqueness index directly into the base SQLite schema (no `ALTER TABLE` upgrades), drop on-disk job-file migration, and remove the `coerceLegacyIdToAlias` shim and its public export.
- 364cb8e: Review fixes and hardening:

  - Captured-session-id lifecycle events are now written to the `crontick` log stream (retrievable via `getLogs(runId, 'crontick')`) instead of the engine stdout stream, matching every other lifecycle event.
  - `getLogs` `source` validation now lives solely in the core `CrontickClient` (throws `VALIDATION_ERROR` for values outside `all`/`engine`/`crontick`); the duplicate CLI-shim guard was removed. `LOG_SOURCES` and `LogSource` are now exported from the public API.
  - Bulk delete (`jobs delete all --force`) is now atomic: a new internal daemon `DELETE /api/jobs` route deletes every job together with its runs, logs, and schedule state in a single store transaction via `Store.deleteAllJobs()`, instead of looping per-job HTTP requests.
  - `GET /api/runs` `limit`/`since` are validated as positive integers, returning a clean `VALIDATION_ERROR` instead of a 500 for `NaN`/negative/`Infinity`; `queryRuns` binds `LIMIT` as a parameter.
  - MCP `redactForLlm` now also redacts single-segment POSIX absolute paths (e.g. `/tmp`) and IPv6 loopback forms (`::1`, `[::1]:port`), and applies redaction to `ENV_FILE_ERROR` messages.
  - Domain validation (`--enable`/`--disable` mutual exclusion, `jobs delete all` force requirement) moved out of the CLI shim into the core, keeping shims logic-free.

- 364cb8e: Review polish: route the reuseSession-ignored notice to the `crontick` log stream, derive the `getLogs` source-validation message (and MCP/daemon schemas) from a single canonical `LOG_SOURCES` module, remove the orphaned `DashboardStartResult`/`DashboardStopResult` exports, use Commander's `InvalidArgumentError` for integer option coercion, and avoid per-chunk transcript-tail reallocation during prompt session-id capture.
- 364cb8e: Round-2 command simplification: fold doctor/daemon/config into `info`, remove delete-run, jobs delete all --force, surface capabilities 26→21.
- 364cb8e: Align SKILL.md with the current CLI/MCP surface, update stale skill test assertions to reference existing tools, and fix the plugin install example command.
- 364cb8e: Rewrite the packaged SKILL.md as a concise, CLI-first guide for driving crontick prompt jobs from an AI agent, aligned with the current 26-capability command surface and the copilot default engine.

## 0.2.0

### Minor Changes

- deb296e: BREAKING: `crontick update` no longer silently succeeds when modifier flags cannot identify what to patch.

  The CLI now fails loudly and leaves the stored job unchanged when you pass any of these flags without the required companion input:

  - `--job-env-file` without `--script`, `--exec`, `--prompt`, or `--prompt-file`
  - `--shell` without `--script`, `--exec`, `--prompt`, or `--prompt-file`
  - `--timeout` without `--script`, `--exec`, `--prompt`, or `--prompt-file`
  - `--tz` without `--cron` (including `--tz` by itself or alongside `--every` / `--at`)

  Also document and test the supported success paths:

  - `crontick update ... --cron <expr> --tz <tz>` updates a cron schedule's timezone
  - library and MCP updates continue to use explicit `schedule` / `action` objects for these changes

- 4e956c9: An orphaned run (one left `running`/`queued` because the daemon that started it is no longer
  live) records a structured `error` on its run row: a message prefixed `"DAEMON_RESTART: "` (e.g.
  `"DAEMON_RESTART: run was canceled because the daemon restarted while it was queued or running"`),
  keyed by the stable code `ORPHAN_RUN_ERROR_CODE` (`"DAEMON_RESTART"`) rather than an ad hoc string.
  Match on the `DAEMON_RESTART:` prefix (or the exported error code) if you need to detect this case
  programmatically.
- deb296e: BREAKING: creating a job is no longer a silent upsert. Duplicate ids now fail with
  `JOB_ALREADY_EXISTS` unless you pass explicit overwrite intent (`--force` on the CLI,
  `force: true` in the library/MCP, or `?force=1|true` on the HTTP route). Use update when
  you want to mutate an existing job in place.

  Related fixes in the same release:

  - Invalid schedules are validated before persistence, so a failed create/update no longer
    leaves a broken or partially replaced job behind.
  - On Windows, PowerShell script jobs now report truthful failures for non-terminating
    errors, uncaught terminating errors, command-not-found, missing-module failures, and
    native non-zero exits; an explicit `exit N` still wins.
  - On Windows, PowerShell script output is captured as faithful UTF-8 regardless of the
    console OEM code page, including output split across stream chunk boundaries.
  - Secret redaction now covers a wider set of token/key shapes and is applied consistently
    across config reads, run/log read surfaces, and dashboard data.
  - Pre-spawn/setup failures now totalize runs as failed instead of leaving invariant-
    breaking runner rejections behind.

- 6d2b540: Add first-class prompt cron jobs for Copilot and Agency. Prompt jobs can be created from the CLI,
  client, HTTP API, or MCP with `action.kind: "prompt"`, raw engine args, explicit sessions, and
  first-run session reuse. Prompt files are normalized to persisted prompt text before jobs are
  stored.

  The daemon is demand-started: any daemon-backed CLI, MCP, or client operation starts it
  automatically on first use, and `crontick daemon start` is available for explicit manual
  lifecycle control. There is no install-time or login/startup registration -- crontick does not
  register itself to launch automatically when you log in or start your machine; see
  `docs/concepts/daemon-lifecycle.md` and ADR 0001 for the reasoning.

- 4e956c9: Argument passing to `--exec`/`--prompt` jobs now has a primary, always-correct form: the
  repeatable `--arg <value>` flag. Use it instead of `--` when you need arguments with spaces,
  embedded quotes, or a leading dash -- it works identically on every shell and every Windows shim
  (`crontick.cmd`, `crontick.ps1`, `npx crontick`). The `--` convenience form still works but is not
  reliable through `crontick.ps1` on Windows (the shim drops a literal `--` before the script ever
  sees it); a crontick flag placed after `--` is now rejected with an explicit error instead of
  being silently absorbed as a literal job argument. See the CLI reference for the full
  platform-by-platform behavior matrix.

  Several run-lifecycle and reliability fixes, all user-visible:

  - A run that hits its `timeoutSec` now records `status: "timeout"`, not `status: "canceled"` --
    the two were previously indistinguishable.
  - On Windows, a `script` job using the default (`pwsh`/`powershell.exe`) shell is spawned attached
    to the daemon's console rather than detached, because a detached PowerShell process on Windows
    produces no output at all. This is the one case that does not survive the daemon exiting;
    every other job (including PowerShell jobs on Linux/macOS, and every `exec`/`prompt` job
    everywhere) is unaffected and continues to survive daemon restarts and shutdowns.
  - Output truncation, once a run's captured stdout/stderr hits its byte cap, no longer splits a
    multi-byte UTF-8 character at the cut point.
  - Process-liveness checks used for orphan/adoption reconciliation now compare a process's actual
    OS-reported start time against the run's recorded start time (not just whether _a_ process with
    that pid exists), so a reused pid can no longer be mistaken for the run that originally owned
    it. The check now queries the OS once in bulk instead of once per process, so startup and
    ongoing polling are faster.
  - `crontick daemon stop` (and the `POST /api/daemon/stop` route it calls) now escalates to
    `SIGTERM` then `SIGKILL` if a graceful stop is accepted but the process doesn't actually exit,
    and reports the true `mode` it used. The response also lists any runs still in progress
    (`activeRuns`) instead of silently leaving them unmentioned.
  - Deleting a job now cancels that job's in-flight run, if it has one, instead of leaving it to run
    orphaned.
  - Restoring runs via `crontick import`/`crontick_import` now validates every row individually:
    a malformed row or one referencing a job that no longer exists is skipped and reported, without
    failing the rest of the batch.
  - A new config key, `retention.maxLogFiles` (default 30), bounds how many daily daemon log files
    are kept on disk; applied at daemon startup and on `crontick daemon reload`.
  - Dashboard/stats average run duration no longer counts `missed`, `queued`, `running`, or
    `canceled` runs -- only runs that actually finished executing (`success`, `failed`, `timeout`).

- 4e956c9: Run history is capped per job: crontick keeps at most `retention.maxRunsPerJob` runs (and their
  logs) per job, default 100, configurable in `config.json` (range 1-100,000). Once a job exceeds
  the cap, the oldest terminal runs (never a currently active `running`/`queued` run) are evicted
  first. The cap can be changed at any time and applied to a running daemon with `crontick daemon
reload` -- no restart required.

  Eviction is a hard delete with no automatic export, prompt, or undo. If you want to keep run
  history beyond the cap, use `crontick export --include-runs` (or the equivalent `includeRuns`
  option on the library/MCP export call) to snapshot it, and `crontick import` to restore it into
  another store.

  BREAKING: this is a major bump because eviction is destructive and on by default, not opt-in. A
  job that accumulates more than 100 runs will have its oldest history pruned automatically as part
  of normal operation.

- 4e956c9: Daemon reliability and observability for v1.0.0:

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

  See the architecture decision records (ADR 0001) for the reasoning and honest trade-offs
  behind each of these.

- deb296e: Fix AWS secret redaction to require high-confidence context instead of treating every bare
  40-character base64-ish token as a secret. This intentionally preserves benign values such
  as `aGVsbG8gd29ybGQgZnJvbSBjcm9udGljayBxYQ==` on logs tail, dashboard data, exports, and
  other shared read surfaces.

  BREAKING: unlabeled standalone 40-character base64-ish values that were previously
  redacted by the old AWS fallback heuristic are no longer redacted unless a nearby
  AWS-specific key hint or access-key-id pair proves the value is credential material.

- deb296e: The library client now uses a short-lived `node:http` loopback transport instead of
  `fetch`/undici so Windows consumers can call `createClient()`, make a daemon-backed request,
  and still exit cleanly. Library docs now also recommend setting `process.exitCode` and letting
  Node exit naturally instead of calling `process.exit()` immediately after daemon-backed work.

  BREAKING: the CLI-only `--env-file` flag has been renamed to `--job-env-file`. The old
  spelling cannot be kept as an alias because Node.js intercepts `--env-file` before
  crontick starts. Persisted job JSON and library/MCP/HTTP payloads still use `action.envFile`.

- deb296e: CLI, client, daemon, and MCP surface polish for the WS6 defect batch:

  - `crontick logs --tail` and MCP `crontick_run_logs_tail` now count reconstructed text lines rather than raw stored log chunks.
  - CLI error output now surfaces structured `details` in both text mode and `--json` mode.
  - `crontick daemon start --json` and `crontick daemon restart --json` now emit structured lifecycle results; `--foreground --json` is rejected up front.
  - Runner failures now distinguish a missing `action.cwd` from a genuinely missing binary. Exec, script, and prompt jobs fail before spawn with an explicit cwd-focused error when `action.cwd` does not exist or is not a directory.
  - BREAKING: MCP single-run tools (`crontick_job_cancel_run`, `crontick_run_get`, and `crontick_run_logs_tail`) now require `id`; the legacy `runId` alias was removed entirely.

### Patch Changes

- deb296e: Clean up legacy internal code and stale docs from the legacy-code-removal-sweep:
  - remove the daemon startup sweep for the old OS temp wrapper directory
  - remove dead internal metadata (`CLIENT_METHODS`) and prune internal-only exports
  - clean stale README, CLI, spec, and examples prose left from older behavior
  - keep supported `CRONTICK_HOME`-managed temp-wrapper behavior and validation coverage intact
  - confirm this is an internal cleanup only; `src/index.ts` and the public API surface are unchanged
- deb296e: Document the round-2 QA defect fixes now implemented in core behavior:

  - Secret redaction is now documented as one shared contract across persisted logs and all read surfaces, including streaming multi-line private-key handling, precise structured key-hint matching, and the two-tier AWS secret heuristic.
  - Job create/update now fail with `ENV_FILE_ERROR` before persistence when `action.envFile` is missing or unreadable, leaving the previously stored job state unchanged.
  - BOM-prefixed JSON is accepted for create/update `--file`, CLI import, and config-file reads/validation, and malformed JSON now reports the file path, parse location, and expected shape instead of surfacing a raw parser failure.

- deb296e: Redact secret-like job `action.env` values from job create/list/get/update responses and redact secret-like config values from config mutation responses across the library, CLI, MCP, and daemon HTTP surfaces.
- deb296e: Improve EOF-truncated JSON diagnostics for shared file reads:

  - `crontick new --file`, `crontick update --file`, `crontick import`, and config read/validate now always report an end-of-input parse position for truncated JSON.
  - When truncation leaves an obvious unfinished construct, the diagnostic now names the missing value, closing bracket, or closing brace alongside the existing expected-shape guidance.

- 4e956c9: `crontick update` (and the equivalent `crontick_job_update` MCP tool and HTTP `PUT` call) preserves
  every field you don't explicitly touch:

  - `overlap` is left as-is unless you pass `--overlap` explicitly -- there is no hidden default that
    resets an existing `queue`/`cancel-previous` policy back to `skip`.
  - Updating one action field (e.g. `--script`) merges into the existing action instead of replacing
    it outright, so `shell`, `envFile`, and `timeoutSec` on script actions, and `args` and
    `reuseSession` on exec/prompt actions, are preserved unless you provide new values.
  - A partial `retry` update (e.g. changing only the retry count) preserves the existing
    `backoffSec`.
  - The prompt `engine` is left alone across updates rather than being re-resolved to the configured
    default.

  This holds identically on the CLI, HTTP API, and MCP surfaces. Switching an action's kind (e.g.
  script to exec) fully replaces the action, since the old action's fields don't apply to the new
  kind.

- deb296e: The built-in `copilot` prompt engine now works out of the box for non-interactive
  runs. Its default args are `['--allow-all-tools', '-p']`, matching
  `buildPromptRunCommand()` so the appended prompt text becomes the `-p` value.

  Documentation now also explains the ordering rule for custom prompt-engine configs:
  if an engine needs an explicit prompt-taking flag, keep that flag last in
  `engine.args` and place any other non-interactive flags before it.

- deb296e: `crontick daemon status` (and the shared daemon status API/client/MCP result) now includes the daemon's loopback `port` and `baseUrl`, so scripts can discover the active daemon endpoint without reading internal state files.

  - `stats summary` and dashboard aggregate/recent-run views now exclude archived runs whose parent job has been deleted. Deleting a job still preserves its historical run/log records for direct run-id lookups.
  - Script-job wrapper files now live under the CRONTICK_HOME-managed data directory, are deleted after each run, and daemon startup best-effort sweeps the legacy `%TEMP%\crontick` location left by older builds.

## 0.1.2

### Patch Changes

- Relocated all unit/vitest tests into `tests/unit/` (previously flat under `tests/`).
- Added an on-demand end-to-end integration test harness under `tests/integration/` (`npm run e2e`); not wired into CI.
- Removed superseded historical manual-test campaign docs.
- Added `docs/e2e-testing.md` documenting the E2E harness.
- Security: `Authorization: Bearer <token>` values are now fully redacted on the streaming/tail run-log read paths (CTD-025), closing a plaintext-token leak.
- Fix: single-field action patches (e.g. `shell`, `envFile`, or `timeout` alone) are now accepted on the library/HTTP surface (CTD-026); modifier-only action patches (no prompt/script/command source) are intentionally rejected on the CLI and MCP surfaces with a clear, fail-loud error — the CLI has always enforced this; MCP now mirrors the same guard so agents receive an actionable error rather than silently mutating a job.
- Docs: clarified the two envFile-related error classes (`ENV_FILE_ERROR` vs update-time `VALIDATION_ERROR`) in `docs/reference/errors.md`.

## 0.1.1

### Patch Changes

- Add npm install troubleshooting documentation for corporate TLS/proxy failures.

## 0.1.0

### Minor Changes

- Initial public release: standalone cron daemon, CLI, dashboard, and MCP server for local scheduled
  jobs.
