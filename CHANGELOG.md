# crontick

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
  `docs/concepts/daemon-lifecycle.md` and ADR 0003 for the reasoning.

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

  See the new architecture decision records (ADR 0014-0018) for the reasoning and honest trade-offs
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
