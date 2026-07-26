# 003: Execution

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-07-25

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
| Run status | One of: `queued`, `running`, `success`, `failed`, `canceled`, `timeout`. |
| Overlap policy | `skip`: drop new tick if active; `queue`: serialize; `cancel-previous`: abort active. |
| Retry | Re-attempt after backoff on failure (not on cancel/timeout). |

## Requirements

### Functional requirements

- **R-003-1**: On tick, the daemon MUST insert a run with status `queued` via `Store.insertRun()` before invoking the runner.
- **R-003-2**: The runner MUST transition the run to `running` before spawning the child process.
- **R-003-3**: `overlap=skip`: If a run for the same job is already active, the new run MUST be immediately finalized as `canceled` with the error `"overlap=skip: another run is already active"`.
- **R-003-4**: `overlap=cancel-previous`: If a run for the same job is active, the runner MUST abort it (via `AbortController`) before starting the new run.
- **R-003-5**: `overlap=queue`: Runs MUST be serialized in FIFO order per job; the queue drains sequentially.
- **R-003-6**: For `script` actions, the runner MUST write the script to a temp file, resolve the shell (`auto` -> pwsh on Windows, bash elsewhere), and spawn the shell with the temp file as argument.
- **R-003-7**: For `exec` actions, the runner MUST spawn `command` with `args` directly (shell=false).
- **R-003-8**: For `prompt` actions, the runner MUST resolve the engine command via `buildPromptRunCommand()` and spawn it with shell=false.
- **R-003-9**: All spawned processes MUST inherit `process.env` merged with `action.env` (action.env wins). If `envFile` is specified, its variables are merged below `action.env` but above `process.env`.
- **R-003-10**: `action.cwd` MUST be used as the working directory; if omitted, `process.cwd()` MUST be used.
- **R-003-11**: If `action.timeoutSec` is set, the spawn MUST use `timeout = timeoutSec * 1000`.
- **R-003-12**: stdout and stderr MUST be captured, redacted via `safeRedact()`, and stored via `Store.appendLog()`.
- **R-003-13**: On exit code 0, run status MUST be `success`. On non-zero exit, status MUST be `failed`.
- **R-003-14**: On `SIGTERM`/`SIGKILL` signal, run status MUST be `canceled`.
- **R-003-15**: On `ETIMEDOUT` error, run status MUST be `timeout`.
- **R-003-16**: On `ABORT_ERR` or signal aborted, run status MUST be `canceled`.
- **R-003-17**: On `ENOENT` for a prompt engine binary, the error message MUST name the engine and suggest corrective action.
- **R-003-18**: Retry MUST re-attempt up to `retry.max` times; on each retry, the runner MUST wait `retry.backoffSec` seconds. Retry MUST NOT occur on `canceled` or `timeout` status.
- **R-003-19**: After all attempts complete (or on final success/cancel/timeout), the runner MUST finalize the run with `endedAt`, `durationMs`, final `status`, `exitCode`, and `error`.
- **R-003-20**: `safeRedact` MUST only redact text-like chunks; binary data (containing NUL bytes or failing UTF-8 round-trip) MUST be stored as-is.
- **R-003-21**: For `script` actions, the temp file MUST be deleted after the process exits (best-effort).
- **R-003-22**: `cancelRun(runId)` MUST abort the active run by its run ID and return true; if no such active run exists, it MUST return false.

### Non-functional requirements

- **R-003-23**: The runner SHOULD NOT block the event loop; all I/O is async or delegated to the child process.
- **R-003-24**: Log capture SHOULD be streamed incrementally (not buffered until exit).

## Behavior

1. Tick arrives -> daemon calls `store.insertRun(jobId, plannedAt)` -> status=`queued`.
2. `runner.run(job, runId, store)` evaluates overlap policy.
3. If allowed to proceed, run transitions to `running`.
4. Runner resolves command/args per action kind; spawns child process.
5. stdout/stderr `data` events -> `safeRedact` -> `store.appendLog`.
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

- Command not found (`ENOENT`): Run finalized as `failed` with descriptive error.
- envFile not found/unreadable: Run fails with `ENV_FILE_ERROR` before spawn.
- Process exits without code (null): Status is `failed`, error "process exited without code".
- Abort during retry backoff: Run finalized as `canceled`, error "canceled before retry".
- Runner callback throws during log append: Run finalized as `failed` with `RUNNER_CALLBACK_FAILED` prefix; child is killed.
- Overlapping cancel-previous race: Active abort maps only cleared if they still point to the current run's controller.
- Binary stdout/stderr: Stored unredacted.

## Acceptance criteria

- [x] overlap=skip cancels new run when active (test file: `tests/integration.overlap.test.ts`)
- [x] overlap=queue serializes runs FIFO (test file: `tests/integration.overlap.test.ts`)
- [x] overlap=cancel-previous aborts active run (test file: `tests/integration.overlap.test.ts`)
- [x] Timeout fires and produces status=timeout (test file: `tests/integration.timeout.test.ts`)
- [x] Retry re-attempts on failure with backoff (test file: `tests/integration.retry.test.ts`)
- [x] Retry stops on cancel/timeout (test file: `tests/integration.retry.test.ts`)
- [x] Script action resolves shell correctly (test file: `tests/runner.test.ts`)
- [x] Exec action spawns command directly (test file: `tests/runner.test.ts`)
- [x] envFile is loaded and merged (test file: `tests/env-file.test.ts`)
- [x] safeRedact skips binary data (test file: `tests/redact.test.ts`)
- [x] cancelRun aborts active run (test file: `tests/runner.test.ts`)
- [x] ENOENT for prompt engine produces actionable error (test file: `tests/runner.test.ts`)

## Out of scope

- Prompt session capture semantics (see spec 007).
- Scheduling logic (see spec 002).
- Persistence/schema details (see spec 006).

## Open questions

None.

## Related

- [001-job-definition.md](001-job-definition.md)
- [002-scheduling.md](002-scheduling.md)
- [006-state-and-persistence.md](006-state-and-persistence.md)
- [007-prompt-jobs.md](007-prompt-jobs.md)
- `../docs/reference/`
- `../docs/concepts/`
