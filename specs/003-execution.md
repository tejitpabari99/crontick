# 003: Execution

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-07-30

## Summary

When the scheduler emits a tick, the daemon creates a run record and delegates to the
runner. The runner applies the overlap policy, spawns a child process appropriate to the
action kind, captures output, enforces timeouts, handles retries, and finalizes the run
status.

## Motivation

Reliable execution with deterministic overlap, retry, and timeout semantics is critical
for a local cron daemon. The runner must handle all three action kinds uniformly while
preserving observability through captured logs and structured run records.

## Terminology

| Term | Definition |
|------|-----------|
| Run | A single execution attempt of a job, identified by a UUID. |
| Run status | One of: `queued`, `running`, `success`, `failed`, `canceled`, `timeout`. (A seventh status, `missed`, is inserted directly by daemon startup for a fire that occurred while no daemon was running -- see spec 004 R-004-28. It is never produced by the runner and is out of scope for this spec.) |
| Overlap policy | `skip`: drop new tick if active; `queue`: serialize; `cancel-previous`: abort active. |
| Retry | Re-attempt after backoff on failure (not on cancel/timeout). |

## Requirements

### Functional requirements

- **R-003-1**: On tick, the daemon MUST insert a run with status `queued` via `Store.insertRun()` before invoking the runner.
- **R-003-2**: The runner MUST transition the run to `running` before spawning the child process.
- **R-003-3**: `overlap=skip`: If a run for the same job is already active, the new run MUST be immediately finalized as `canceled` with the error `"overlap=skip: another run is already active"`.
- **R-003-4**: `overlap=cancel-previous`: If a run for the same job is active, the runner MUST abort it (via `AbortController`) before starting the new run.
- **R-003-5**: `overlap=queue`: Runs MUST be serialized in FIFO order per job; the queue drains sequentially.
- **R-003-6**: For `script` actions, the runner MUST write the script to a temp file under the managed data root (`<dataDir>/tmp/scripts/`), resolve the shell (`auto` -> pwsh on Windows, bash elsewhere), and spawn the shell with the temp file as argument. When the resolved shell is PowerShell (`pwsh`/`powershell`), the runner MUST invoke a wrapper script (also under `<dataDir>/tmp/scripts/`) that preserves an explicit user `exit N`, promotes PowerShell/native failures to a truthful non-zero exit status, and sets UTF-8 output encoding before the user script runs.
- **R-003-7**: For `exec` actions, the runner MUST spawn `command` with `args` directly and verbatim (shell=false): no shell interpretation, no whitespace splitting, no re-quoting. `args` is the array produced by the CLI's repeatable `--arg <value>` flag (the primary, shim-independent mechanism) or its `--` convenience form (or the library API's `args` field), so an argument containing a space or shell metacharacter MUST pass through to the child exactly as given.
- **R-003-8**: For `prompt` actions, the runner MUST resolve the engine command via `buildPromptRunCommand()` and spawn it with shell=false.
- **R-003-9**: All spawned processes MUST inherit `process.env` merged with `action.env` (action.env wins). If `envFile` is specified, its variables are merged below `action.env` but above `process.env`.
- **R-003-10**: `action.cwd` MUST be used as the working directory; if omitted, `process.cwd()` MUST be used. If `action.cwd` is provided but does not exist or is not a directory, the runner MUST fail the run before spawn with `ACTION_CWD_INVALID: <kind> action cwd ...` naming both the action kind and the rejected path.
- **R-003-11**: If `action.timeoutSec` is set, the runner MUST start its own timer for `timeoutSec * 1000` ms (not the spawn-level `timeout` option, which cannot be distinguished from a user cancellation -- see R-003-15) and, on expiry, send `SIGTERM` to the child itself.
- **R-003-12**: stdout and stderr MUST be captured, redacted via `safeRedact()`, and stored via `Store.appendLog()`. For text-like output, the shared redaction contract MUST redact full `BEGIN/END ... PRIVATE KEY` blocks, lone private-key markers, high-confidence structured secret values, and AWS secret-access-key values only when a high-confidence key hint or nearby AWS access-key-id pair context is present before persistence. Streaming capture MUST preserve that protection even when a private-key block spans multiple chunks or lines. For PowerShell script jobs, capture MUST also preserve UTF-8 byte sequences exactly across chunk boundaries instead of splitting a multibyte character.
- **R-003-13**: On exit code 0, run status MUST be `success`. On non-zero exit, status MUST be `failed`. For PowerShell script jobs this includes non-terminating errors, uncaught terminating errors, command-not-found, missing-module failures, and native non-zero exits that occur without an explicit `exit N`; an explicit `exit N` remains authoritative.
- **R-003-14**: On `SIGTERM`/`SIGKILL` signal that was NOT sent by the runner's own timeout timer (R-003-11) -- i.e. a user cancellation or overlap-policy abort -- run status MUST be `canceled`.
- **R-003-15**: On expiry of the runner's own timeout timer (R-003-11), run status MUST be `timeout`, distinct from `canceled`, with an error message naming `timeoutSec`.
- **R-003-16**: On `ABORT_ERR` or signal aborted, run status MUST be `canceled`.
- **R-003-17**: On `ENOENT` for a prompt engine binary, the error message MUST name the engine and suggest corrective action.
- **R-003-18**: Retry MUST re-attempt up to `retry.max` times; on each retry, the runner MUST wait `retry.backoffSec` seconds. Retry MUST NOT occur on `canceled` or `timeout` status.
- **R-003-19**: After all attempts complete (or on final success/cancel/timeout), the runner MUST finalize the run with `endedAt`, `durationMs`, final `status`, `exitCode`, and `error`.
- **R-003-20**: `safeRedact` MUST only redact text-like chunks; binary data (containing NUL bytes or failing UTF-8 round-trip) MUST be stored as-is.
- **R-003-21**: For `script` actions, every temp wrapper/user-script file MUST be deleted after the process exits (best-effort), regardless of whether the run succeeded, failed, timed out, or was canceled.
- **R-003-22**: `cancelRun(runId)` MUST abort the active run by its run ID and return true; if no such active run exists, it MUST return false.
- **R-003-25**: Every spawn (script, exec, and prompt actions alike) MUST pass `windowsHide: true` and `detached: true` to the child process, with exactly one exception: a `script` action on Windows whose resolved shell is `pwsh`/`powershell.exe` MUST be spawned with `detached: false`, because a detached PowerShell host on Windows receives no console and writes nothing to its (even redirected) stdio. A daemon restart or graceful stop MUST NOT kill in-flight work as a side effect for any other combination of platform/action/shell; the pwsh-on-Windows exception trades that survival guarantee for non-empty output capture (see `../docs/decisions/0020-no-detach-powershell-script-jobs-windows.md`).
- **R-003-26**: The child process's `pid` MUST be persisted to the run record (`Store.updateRun()`) as soon as the process spawns, before any output arrives; `missed` runs (spec 004 R-004-28) never spawn a process and so never get a `pid`.
- **R-003-27**: Captured stdout/stderr for a single run MUST be capped at `retention.maxOutputBytesPerRun` (default 2,000,000; configurable range 1024..1,000,000,000). Once the cap is reached, the runner MUST trim the trailing bytes to a UTF-8 character boundary (never splitting a multi-byte character), append a single truncation marker, set the run's `outputTruncated` field, and drop all further output for that run without persisting it. Hitting the cap MUST NOT kill, signal, or otherwise affect the child process itself; only capture stops.
- **R-003-28**: `Runner.adoptRun(jobId, runId, pid, store)` MUST re-attach a run that survived a daemon restart (per spec 004 R-004-8) into this daemon's overlap tracking (`activeRunIds`), so that `overlap: 'skip'` and `overlap: 'cancel-previous'` hold for a subsequent tick of the same job exactly as they would for a run spawned by this daemon process. Since no `ChildProcess` handle exists for an adopted run, the runner MUST poll process liveness periodically instead of listening for a native `'exit'` event, and MUST finalize the run once the poll observes the process has exited.

### Non-functional requirements

- **R-003-23**: The runner SHOULD NOT block the event loop; all I/O is async or delegated to the child process.
- **R-003-24**: Log capture SHOULD be streamed incrementally (not buffered until exit).

## Behavior

1. Tick arrives -> daemon calls `store.insertRun(jobId, plannedAt)` -> status=`queued`.
2. `runner.run(job, runId, store)` evaluates overlap policy.
3. If allowed to proceed, run transitions to `running`.
4. Runner resolves command/args per action kind; script jobs materialize transient wrapper files under `<dataDir>/tmp/scripts/`, and a PowerShell script job emits a wrapper + user script pair there so exit semantics and UTF-8 output are normalized before spawn.
5. stdout/stderr `data` events -> per-stream UTF-8 buffering (when needed) + per-stream private-key streaming redaction -> `safeRedact` -> `store.appendLog`.
6. Child `close` event determines status from exit code/signal.
7. If failed and retries remain, waits backoff then re-spawns (step 4).
8. `finalizeRun` writes terminal status, endedAt, durationMs to store.
9. For queued overlap, the queue drains to the next entry after finalization.

## Inputs and outputs

**Input**: A `Job` object, a run ID (UUID), and a `Store` reference.
**Output**: Side effects only (store mutations, log entries). No return value from `run()`.
**Run record fields**: `id`, `jobId`, `startedAt`, `endedAt`, `status`, `exitCode`, `error`, `durationMs`.
**Log record fields**: `runId`, `stream` (stdout/stderr), `ts`, `chunk` (Buffer).

## Edge cases and failure modes

- Missing or non-directory `action.cwd`: Run finalized as `failed` before spawn with an `ACTION_CWD_INVALID` message naming the action kind and path.
- Command not found (`ENOENT`): Run finalized as `failed` with descriptive error. When the missing binary is a prompt engine command, the error remains the existing PATH-focused guidance rather than the cwd-preflight message.
- envFile not found/unreadable: Run fails with `ENV_FILE_ERROR` before spawn.
- Private-key PEM output split across chunk/line boundaries: persisted log bytes store a single redacted placeholder rather than raw begin/body/end fragments.
- Contextual or nearby-access-key-paired AWS secret-access-key output is redacted, while unlabeled standalone 40-character base64-ish values, benign lookalikes, and non-private-key PEM text remain visible.
- PowerShell non-terminating or uncaught terminating error without explicit `exit N`: the wrapper exits non-zero and the run finalizes `failed` instead of `success/0`.
- PowerShell UTF-8 output split across chunk boundaries: buffered per stream and reconstructed exactly before persistence.
- Process exits without code (null): Status is `failed`, error "process exited without code".
- Abort during retry backoff: Run finalized as `canceled`, error "canceled before retry".
- Runner callback throws during log append: Run finalized as `failed` with `RUNNER_CALLBACK_FAILED` prefix; child is killed.
- Overlapping cancel-previous race: Active abort maps only cleared if they still point to the current run's controller.
- Binary stdout/stderr: Stored unredacted.
- Output exceeds `retention.maxOutputBytesPerRun`: capture truncates, `outputTruncated` is set, the run otherwise completes normally.
- Daemon restarts mid-run: the detached child keeps running; the next startup's orphan reconciliation adopts it (liveness confirmed) or cancels the run (liveness confirmed dead) -- see spec 004 R-004-8.

## Acceptance criteria

- [x] overlap=skip cancels new run when active (test file: `tests/integration.overlap.test.ts`)
- [x] overlap=queue serializes runs FIFO (test file: `tests/integration.overlap.test.ts`)
- [x] overlap=cancel-previous aborts active run (test file: `tests/integration.overlap.test.ts`)
- [x] Timeout fires and produces status=timeout, distinct from a user/overlap cancellation (test file: `tests/integration.timeout.test.ts`; exact-status assertion in `tests/runner.test.ts`, "exec: timeout cancels long-running job")
- [x] Retry re-attempts on failure with backoff (test file: `tests/integration.retry.test.ts`)
- [x] Retry stops on cancel/timeout (test file: `tests/integration.retry.test.ts`)
- [x] Script action resolves shell correctly (test file: `tests/runner.test.ts`)
- [x] Exec action spawns command directly (test file: `tests/runner.test.ts`)
- [x] envFile is loaded and merged (test file: `tests/env-file.test.ts`)
- [x] safeRedact skips binary data (test file: `tests/redact.test.ts`)
- [x] Streaming private-key and contextual or nearby-access-key-paired AWS-secret redaction protects persisted logs without over-redacting benign key names, benign standalone 40-character base64-ish values, or non-private-key PEM text (test files: `tests/redact.test.ts`, `tests/secret-redaction.ctd-003.test.ts`)
- [x] cancelRun aborts active run (test file: `tests/runner.test.ts`)
- [x] ENOENT for prompt engine produces actionable error, while a missing `action.cwd` fails earlier with a consistent explicit cwd message across script/exec/prompt actions (test files: `tests/runner.test.ts`, `tests/spawn-enoent-cwd.ctd-011.test.ts`)
- [x] Spawn sets `detached: true` and `windowsHide: true` for every action kind except a Windows pwsh/powershell.exe script job, which is spawned attached so it can produce output (test file: `tests/runner.test.ts`, "script: shell=\"auto\" (the default job kind) captures non-empty output on every platform (BLOCKER 1 regression)")
- [x] Child `pid` is persisted on the run row as soon as the process spawns (test file: `tests/runner.test.ts`, "spawn: persists the child pid on the run row...")
- [x] Output byte cap truncates capture at a UTF-8 character boundary, sets `outputTruncated`, and never affects the child process (test file: `tests/runner.test.ts`, "truncateToUtf8Boundary: ..." and "captureChunk: truncation at the byte cap does not split a multi-byte character (MINOR 7 regression)")
- [x] `adoptRun` re-attaches overlap tracking for `skip` and `cancel-previous` across a restart (test file: `tests/runner.test.ts`, `adoptRun` describe block)
- [x] PowerShell script jobs fail truthfully for implicit PowerShell/native failures while preserving explicit `exit N` (test file: `tests/powershell-exit.ctd-002.test.ts`)
- [x] PowerShell script jobs preserve exact UTF-8 bytes across Windows code pages and chunk boundaries (test file: `tests/powershell-utf8.ctd-008.test.ts`)
- [x] Script temp wrappers live under CRONTICK_HOME-managed state and are removed after the run (test file: `tests/temp-script-cleanup.ctd-017.test.ts`)
- [x] Repeatable `--arg <value>` round-trips spaces, embedded quotes, and a leading dash, and is mutually exclusive with `--` (test file: `tests/cli.test.ts`, "crontick new --arg round-trips a value with spaces, embedded double quotes, and a leading dash"; "crontick new rejects combining --arg with -- positional args (ambiguous args source)")
- [x] `--exec` takes its command and args verbatim, with no whitespace splitting (test file: `tests/job-input.test.ts`, "buildJobFromCreateOptions -- --exec verbatim + rawArgs"; `tests/cli.test.ts`, "new --help describes --exec's real verbatim-command + --arg/-- args behavior")

## Out of scope

- Prompt session capture semantics (see spec 007).
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
- `../docs/reference/`
- `../docs/concepts/`
- `../docs/decisions/0016-detached-children-cross-platform.md` (superseded by 0020)
- `../docs/decisions/0018-exec-dash-dash-args.md` (superseded by 0019)
- `../docs/decisions/0019-arg-flag-primary-for-exec-and-prompt-args.md`
- `../docs/decisions/0020-no-detach-powershell-script-jobs-windows.md`
