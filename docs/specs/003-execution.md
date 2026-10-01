# 003: Execution

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-09-28

Audience: contributors and coding agents changing the runner or engine adapters.
Non-duplication: this spec is the normative contract; for the mental model see
[concepts/execution.md](../concepts/execution.md), and for implementation detail see
[implementation/prompt-execution.md](../implementation/prompt-execution.md) and
[implementation/engines.md](../implementation/engines.md).

## Summary

When the scheduler emits a tick, the daemon creates a run record and delegates to the runner.
The runner applies the overlap policy, spawns the configured prompt engine, captures output,
enforces timeouts, handles retries, and finalizes the run status. Engine-specific invocation and
result parsing live in an adapter selected by `engine.type` (see spec 007).

## Motivation

Reliable execution with deterministic overlap, retry, and timeout semantics is critical for a
local cron daemon, with observability through captured logs and structured run records.

## Terminology

| Term | Definition |
|------|-----------|
| Run | A single execution attempt of a job, identified by a UUID. |
| Run status | One of: `queued`, `running`, `success`, `failed`, `canceled`, `skipped`, `timeout`. `missed` is inserted directly by daemon startup for a fire that occurred while no daemon was running (spec 004 R-004-28). |
| Overlap policy | `skip`: drop new tick if active; `queue`: serialize; `cancel-previous`: abort active. |
| Retry | Re-attempt after backoff on failure (not on cancel/timeout). |

## Requirements

### Functional requirements

- **R-003-1**: On tick, the daemon MUST insert a run with status `queued` via `Store.insertRun()` before invoking the runner.
- **R-003-2**: The runner MUST transition the run to `running` before spawning the child process.
- **R-003-3**: `overlap=skip`: if a run for the same job is already active, the new run MUST be immediately finalized as `skipped` with error `"overlap=skip: another run is already active"`; it MUST NOT start a process or cancel the active run.
- **R-003-4**: `overlap=cancel-previous`: if a run for the same job is active, the runner MUST abort it (via `AbortController`) before starting the new run.
- **R-003-5**: `overlap=queue`: runs MUST be serialized in FIFO order per job; the queue drains sequentially.
- **R-003-8**: The runner MUST resolve the engine adapter for `action.engine ?? config.defaultEngine`, ask it to build the invocation, and spawn it with `shell: false`.
- **R-003-9**: All spawned processes MUST inherit `process.env` merged with `action.env` (action.env wins). If `envFile` is specified, its variables are merged below `action.env` but above `process.env` and above engine-config `env`.
- **R-003-10**: `action.cwd` MUST be used as the working directory; if omitted, `process.cwd()` MUST be used. If `action.cwd` is provided but does not exist or is not a directory, the runner MUST fail the run before spawn with `ACTION_CWD_INVALID: prompt action cwd ...` naming the rejected path.
- **R-003-11**: If `action.timeoutSec` is set, the runner MUST start its own timer for `timeoutSec * 1000` ms (not the spawn-level `timeout` option, which cannot be distinguished from a user cancellation -- see R-003-15) and, on expiry, send `SIGTERM` to the child itself.
- **R-003-12**: stdout and stderr MUST be captured, redacted via `safeRedact()`, and stored via `Store.appendLog()`. The shared redaction contract MUST redact full private-key blocks, high-confidence structured secret values, and contextually-paired AWS secret-access-key values, preserved across chunk/line boundaries.
- **R-003-13**: On exit code 0 with no adapter-reported error, run status MUST be `success`. On non-zero exit, or an adapter-reported error (e.g. Claude `is_error`), status MUST be `failed`.
- **R-003-14**: On `SIGTERM`/`SIGKILL` signal that was NOT sent by the runner's own timeout timer (R-003-11), run status MUST be `canceled`.
- **R-003-15**: On expiry of the runner's own timeout timer, run status MUST be `timeout`, distinct from `canceled`, with an error message naming `timeoutSec`.
- **R-003-16**: On `ABORT_ERR` or signal aborted, run status MUST be `canceled`.
- **R-003-17**: On `ENOENT` for the prompt engine binary, the error message MUST name the engine and suggest corrective action.
- **R-003-18**: Retry MUST re-attempt up to `retry.max` times; on each retry, the runner MUST wait `retry.backoffSec` seconds. Retry MUST NOT occur on `canceled` or `timeout` status, nor on non-retryable engine errors (R-003-34).
- **R-003-19**: After all attempts complete, the runner MUST finalize the run with `endedAt`, `durationMs`, final `status`, `exitCode`, and `error`.
- **R-003-20**: `safeRedact` MUST only redact text-like chunks; binary data (NUL bytes or failed UTF-8 round-trip) MUST be stored as-is.
- **R-003-22**: `cancelRun(runId)` MUST abort the active run by its run ID and return true; if no such active run exists, it MUST return false.
- **R-003-25**: Every spawn MUST pass `windowsHide: true` and `detached: true` to the child process, with exactly one exception: when the resolved engine command's basename is `pwsh`/`powershell.exe` on Windows, it MUST be spawned with `detached: false`, because a detached PowerShell host on Windows receives no console and writes nothing to its stdio. A daemon restart or graceful stop MUST NOT kill in-flight work as a side effect for any other combination (see [ADR 0001](../decisions/0001-architecture-and-runtime-model.md)).
- **R-003-26**: The child process's `pid` MUST be persisted to the run record as soon as the process spawns, before any output arrives; `missed` runs never spawn a process and so never get a `pid`.
- **R-003-27**: Captured stdout/stderr for a single run MUST be capped at `retention.maxOutputBytesPerRun` (default 2,000,000; configurable 1024..1,000,000,000). Once reached, the runner MUST trim to a UTF-8 character boundary, append a single truncation marker, set `outputTruncated`, and drop further output without persisting it. Hitting the cap MUST NOT affect the child process itself.
- **R-003-28**: `Runner.adoptRun(jobId, runId, pid, store)` MUST re-attach a run that survived a daemon restart (spec 004 R-004-8) into this daemon's overlap tracking, so `overlap: 'skip'`/`'cancel-previous'` hold for a subsequent tick exactly as for a run spawned by this daemon. Since no `ChildProcess` handle exists for an adopted run, the runner MUST poll process liveness periodically and finalize the run once the poll observes it exited.
- **R-003-29**: In addition to the engine's `stdout`/`stderr` streams, the runner MUST record its own scheduling/execution lifecycle events on a dedicated `crontick` log stream via `Store.appendLog(runId, 'crontick', ...)`, redacted like engine output.
- **R-003-30**: Raw log retrieval by `source` (`all`/`engine`/`crontick`) MUST remain available on `Store.getLogs()` and the daemon route `GET /api/runs/:id/logs[?source=]`. The client method `getLogs`, the CLI `runs logs`/`runs output` commands and the MCP tools `crontick_run_logs_tail`/`crontick_run_output` were removed: `runs get` / `crontick_run_get` return the run record, `logFile` and the cleaned output instead.
- **R-003-31**: Every run's logs MUST additionally be mirrored to a per-job log file at `<logging.dir ?? <dataDir>/logs>/<jobId>.log`, controlled by `logging.fileEnabled`/`logging.dir`. File logging MUST be best-effort and MUST NEVER block or fail a run, behind an injectable interface.
- **R-003-32**: A Claude invocation MUST append an ephemeral `--settings` JSON with a `SessionEnd` command hook, implemented by a plain helper script at `<dataDir>/hooks/session-end.cjs` (no `eval`/base64; marker path passed as argv; omitted entirely when the helper cannot be written or paths are unsafe), writing `{exitStatus, sessionId}` to `<dataDir>/runs/<runId>.claude-hook.json`, without editing the user's Claude settings. For a normal run, `parseResult` and the process exit remain authoritative; the marker only supplements restart recovery.
- **R-003-33**: While a run is live, the runner MUST scan complete stdout lines with the engine adapter's `detectTerminalError`. When the engine reports a terminal failure in-band (Claude: a `result` event with `is_error: true`, or an assistant message flagged with an authentication API error such as 401 / `authentication_error`), the run MUST end `failed` with the parsed error message: if the process exits within `TERMINAL_ERROR_SETTLE_MS` (2s) the normal close path finalizes it (keeping the real exit code); otherwise the runner MUST finalize it anyway, terminate the process tree (`taskkill /PID <pid> /T /F` on Windows, process-group SIGTERM on POSIX), and force-kill after `KILL_GRACE_MS` (5s). The active-run lock MUST be released at finalization so the next tick is not `skipped`.
- **R-003-34**: A terminal engine error that a retry cannot fix (authentication) MUST NOT be retried even when `retry.max > 0`.
- **R-003-35**: A run MUST always finalize: after SIGTERM for a timeout or cancel the runner MUST force-kill the process tree after `KILL_GRACE_MS` and finalize (`timeout`/`canceled`) even if `close` never arrives; if the process `exit`s but stdio stays open (inherited by a grandchild), the run MUST finalize `EXIT_CLOSE_GRACE_MS` (3s) after `exit`.
- **R-003-36**: `run-now` (`CrontickClient.runNow`, `crontick jobs run-now`, `crontick_job_run_now`, `POST /api/jobs/:id/run-now` with `/run` as an alias) MUST run the job once immediately regardless of `enabled`, MUST NOT change `enabled` or the schedule, and MUST honour the overlap policy. It returns `202 { runId }`.
- **R-003-37**: The run output view (`getOutput` (library-only), `crontick runs get`, `crontick_run_get`, `GET /api/runs/:id/output`) MUST be derived from the stored engine (`stdout`/`stderr`) log without modifying it, MUST return `{ runId, status, format, result, error, output, stderr, sessionId, costUsd, turns, durationMs, truncated }`, and MUST omit Claude `thinking` blocks/`signature` values, hook events, tool results and base64 hook payloads.
- **R-003-38**: The stored run `command` and diagnostic log lines MUST show the `--settings` value as `<session-end-hook>`. The per-job log file is shared by all runs of the job; `GET /api/runs/:id` MUST include `logFile` (absolute path, or null when `logging.fileEnabled=false`). Raw `usageJson` storage is unchanged; display surfaces use `normalizeUsage`.

- **R-003-39**: `crontick runs get <runId>` MUST print one `Label: value` line per run field (local ISO-8601 timestamps, `Runner Session ID`, `Status` exactly once), `Transcript:` with `Log file:` directly below it, a blank line, then the cleaned output (`Error:`, the final answer or readable transcript, `[stderr]` only without an error); `--json` MUST print `{ run, output }`. `crontick_run_get` MUST return the run record plus `logFile` and `output`.
- **R-003-40**: A job runs in `action.cwd` (default: the invoking directory on create, resolved absolute and existing, else `INVALID_CWD`). For engines with trust hooks (Claude) create/update (when cwd or engine changes)/import MUST throw `TRUST_REQUIRED` before persisting when the folder (or an ancestor) lacks `hasTrustDialogAccepted: true` in `$CLAUDE_CONFIG_DIR/.claude.json` (else `~/.claude.json`), unless `trustFolder` is set, in which case only that flag is written (other keys preserved; unparsable file: `CLAUDE_CONFIG_UNREADABLE`; stat-guarded atomic rename with up to 3 retries). Moving a job with a session to a different cwd MUST fail with `CWD_CHANGE_BREAKS_SESSION` unless a new `sessionId` or `reuseSession: true` is given.

### Non-functional requirements

- **R-003-23**: The runner SHOULD NOT block the event loop; all I/O is async or delegated to the child process.
- **R-003-24**: Log capture SHOULD be streamed incrementally (not buffered until exit).

## Behavior

1. Tick arrives -> daemon calls `store.insertRun(jobId, plannedAt)` -> status=`queued`.
2. `runner.run(job, runId, store)` evaluates overlap policy; if allowed, transitions to `running`.
3. Runner resolves the engine adapter and invocation (spec 007), then spawns with `shell: false`.
4. stdout/stderr `data` events -> streaming redaction -> `safeRedact` -> `store.appendLog`.
5. Child `close` event: the adapter parses the exit code and captured output into status/session/usage.
6. If failed and retries remain, waits backoff then re-spawns (step 3).
7. `finalizeRun` writes terminal status, endedAt, durationMs to store; for `queued` overlap, the queue drains to the next entry.

## Inputs and outputs

**Input**: A `Job` object, a run ID (UUID), and a `Store` reference.
**Output**: Side effects only (store mutations, log entries).
**Run record fields**: `id`, `jobId`, `startedAt`, `endedAt`, `status`, `exitCode`, `error`, `durationMs`, `sessionId?`, `costUsd?`, `turns?`, `usageJson?`, `transcriptPath?`, `engineStatus?`.
**Log record fields**: `runId`, `stream` (`stdout`/`stderr` engine output; `crontick` lifecycle events), `ts`, `chunk`.

## Edge cases and failure modes

- Missing or non-directory `action.cwd`: run finalized `failed` before spawn with `ACTION_CWD_INVALID`.
- Command not found (`ENOENT`): run finalized `failed` with the engine-PATH-focused error message.
- `envFile` not found/unreadable: run fails with `ENV_FILE_ERROR` before spawn.
- Private-key or secret output split across chunk/line boundaries: persisted log bytes store a single redacted placeholder.
- Process exits without code (null): status `failed`, error "process exited without code".
- Abort during retry backoff: run finalized `canceled`, error "canceled before retry".
- Runner callback throws during log append: run finalized `failed` with `RUNNER_CALLBACK_FAILED` prefix; child is killed.
- Overlapping cancel-previous race: active abort maps only cleared if they still point to the current run's controller.
- Binary stdout/stderr: stored unredacted.
- Output exceeds `retention.maxOutputBytesPerRun`: capture truncates, `outputTruncated` is set, the run otherwise completes normally.
- Daemon restarts mid-run: the detached child keeps running; the next startup's orphan reconciliation adopts it (liveness confirmed) or cancels the run (confirmed dead) -- see spec 004 R-004-8.

## Acceptance criteria

- [x] overlap=skip records the new run as `skipped` when active (test files: `tests/unit/integration.overlap.test.ts`, `tests/unit/runner.test.ts`)
- [x] overlap=queue serializes runs FIFO (test file: `tests/unit/integration.overlap.test.ts`)
- [x] overlap=cancel-previous aborts active run (test file: `tests/unit/integration.overlap.test.ts`)
- [x] Timeout fires and produces status=timeout, distinct from a user/overlap cancellation (test file: `tests/unit/integration.timeout.test.ts`; `tests/unit/runner.test.ts`)
- [x] Retry re-attempts on failure with backoff, and stops on cancel/timeout (test file: `tests/unit/integration.retry.test.ts`)
- [x] envFile is loaded and merged (test file: `tests/unit/env-file.test.ts`)
- [x] safeRedact skips binary data (test file: `tests/unit/redact.test.ts`)
- [x] Streaming secret redaction protects persisted logs without over-redacting benign values (test files: `tests/unit/redact.test.ts`, `tests/unit/secret-redaction.test.ts`)
- [x] cancelRun aborts active run (test file: `tests/unit/runner.test.ts`)
- [x] ENOENT for the prompt engine produces an actionable error, and a missing `action.cwd` fails earlier with an explicit cwd message (test files: `tests/unit/runner.test.ts`, `tests/unit/spawn-enoent-cwd.test.ts`)
- [x] Spawn sets `detached: true` and `windowsHide: true` except a Windows pwsh/powershell.exe engine command, spawned attached (test file: `tests/unit/runner.test.ts`)
- [x] Child `pid` is persisted on the run row as soon as the process spawns (test file: `tests/unit/runner.test.ts`)
- [x] Output byte cap truncates capture at a UTF-8 character boundary, sets `outputTruncated`, and never affects the child process (test file: `tests/unit/runner.test.ts`)
- [x] `adoptRun` re-attaches overlap tracking for `skip` and `cancel-previous` across a restart (test file: `tests/unit/runner.test.ts`, `adoptRun` describe block)
- [x] Claude adapter invocation, result parsing, and session resume preflight (test files: `tests/unit/claude-adapter.test.ts`, `tests/unit/integration.prompt-e2e.test.ts`)
- [x] Raw adapter invocation and generic session extraction (test file: `tests/unit/raw-adapter.test.ts`)

## Out of scope

- Prompt session capture semantics and adapter contract details (see spec 007).
- Scheduling logic (see spec 002).
- Persistence/schema details (see spec 006).

## Open questions

None.

## Related

- [001-job-definition.md](001-job-definition.md)
- [002-scheduling.md](002-scheduling.md)
- [004-daemon.md](004-daemon.md)
- [006-state-and-persistence.md](006-state-and-persistence.md)
- [007-prompt-jobs.md](007-prompt-jobs.md)
- [../decisions/0001-architecture-and-runtime-model.md](../decisions/0001-architecture-and-runtime-model.md)
- [../decisions/0002-prompt-only-jobs-and-engine-adapters.md](../decisions/0002-prompt-only-jobs-and-engine-adapters.md)
