# Execution

Audience: users and contributors reasoning about how a run actually happens. Non-duplication:
for the exact spawn/redaction/adoption mechanics see
[implementation/prompt-execution.md](../implementation/prompt-execution.md); for the engine adapter
contract see [implementation/engines.md](../implementation/engines.md); for the normative contract see
[specs/003-execution.md](../specs/003-execution.md).

After reading this page: how crontick turns a scheduled tick into a completed run.

## From tick to run

The scheduler emits a `tick` event with `{ jobId, plannedAt }`; the daemon fetches the job
(dropping the tick if missing or disabled), inserts a `queued` run, and calls `Runner.run()`.

## Overlap enforcement

Before spawning, the Runner checks the job's `overlap` policy: **skip** finalizes the new run as
`skipped` without starting a process if another is active; **cancel-previous** signals the active
run's `AbortController`, then proceeds; **queue** places the new run in a per-job FIFO drained
sequentially.

Overlap state lives in the daemon process's memory, not `runs.db`. A restart drops it, but it's
rebuilt for any run that survived: orphan reconciliation liveness-checks each `running` run's
`pid` and, if alive (or inconclusive), re-registers it via `Runner.adoptRun()`. See
[daemon-lifecycle.md](./daemon-lifecycle.md#what-happens-while-the-daemon-is-down).

## Process spawn

The runner resolves the job's engine (via its adapter -- see
[implementation/engines.md](../implementation/engines.md)) into a concrete command/args/env, then spawns it
with `shell: false`, stdin ignored, and `detached: true, windowsHide: true` -- except
`pwsh`/`powershell.exe` on Windows, spawned attached because detached processes get no console
there and PowerShell needs one to write output
(see [ADR 0001](../decisions/0001-architecture-and-runtime-model.md)).
Detaching otherwise means a daemon restart or crash never kills a running job -- it keeps running
(see [orphan reconciliation](./daemon-lifecycle.md#what-happens-while-the-daemon-is-down)) or has
already exited. The child's `pid` is persisted onto its run row as soon as known.

The child inherits `action.cwd` if set, otherwise `process.cwd()`. Environment merges (highest
wins): `action.env` > `envFile` variables > engine-config `env` > `process.env`.

## Output and the log file

crontick does not store the engine's raw stdout/stderr; the engine keeps its own transcript. The
runner parses stdout line by line as it arrives and keeps only the final `result` event and the
stderr (capped; everything else is discarded immediately, so memory does not grow with stream length);
when the run finishes it stores the redacted result (final answer, error, stderr) with the run. crontick's own lifecycle
events -- run started, executing, run finished, overlap skips, retry backoffs, session capture -- go
to a per-job file at `<dataDir>/logs/<jobId>.log`, one timestamped line per event tagged with the run
id (see [configuration reference](../reference/configuration.md#loggingconfig)). `runs get` shows the
cleaned output and the log file path; there is no log command.

Plain stdout per run is bounded by `retention.maxOutputBytesPerRun` (default 2,000,000 bytes) and stderr by a fixed 1,000,000-byte cap (`DEFAULT_MAX_STDERR_BYTES_PER_RUN`); once a cap is hit,
crontick trims to a UTF-8 character boundary, appends a truncation marker, and stops capturing
further chunks -- the
child process itself is never killed or throttled by hitting the cap.

## Timeouts

When `action.timeoutSec` is set, the Runner starts its own timer alongside the spawn (not Node's
`spawn(..., { timeout })`, indistinguishable from a plain cancellation). If the child hasn't
exited when the timer elapses, the Runner sends `SIGTERM` directly and records `timeout` (naming
`timeoutSec`), rather than `canceled`.

## Exit-status interpretation

| Condition | Run status |
|-----------|------------|
| Exit code 0, no adapter-reported error | `success` |
| Exit code non-zero, or adapter-reported error (e.g. Claude `is_error`) | `failed` |
| Runner-initiated timeout | `timeout` |
| Signal SIGTERM/SIGKILL (cancellation) | `canceled` |
| ENOENT (engine not found) or no exit code | `failed` |

`skipped` and `missed` fall outside this table. `skipped` finalizes before any process spawns,
when overlap `skip` finds another run active -- distinct from `canceled`, which stops an
already-started process. `missed` is recorded directly by the daemon's startup missed-fire pass
for a fire that had no run because the daemon wasn't running. See
[daemon-lifecycle.md](./daemon-lifecycle.md#what-happens-while-the-daemon-is-down).

## Engine-reported failures and stuck processes

If the engine reports a terminal failure in its output (for example Claude's `result` with `is_error: true`, or a 401 authentication error), the run is marked `failed` with that message within a couple of seconds and the process tree is terminated if it has not exited, so the next scheduled tick runs instead of being `skipped` behind a stuck run. Authentication failures are never retried. Timed-out and canceled runs are force-killed after a short grace period and always finalize.

## Retry behavior

If `retry.max > 0`, the Runner loops up to `max + 1` attempts, sleeping `retry.backoffSec`
seconds between them, stopping early on `success`, `canceled`, or `timeout`.

## How prompt jobs differ

- **Engine resolution**: `action.engine` (or `config.defaultEngine`, the built-in `claude` engine
  unless changed) selects a configured engine, whose **adapter** turns it into a concrete
  invocation -- see [implementation/engines.md](../implementation/engines.md) and
  [specs/007-prompt-jobs.md](../specs/007-prompt-jobs.md).
- **Session precedence**: an explicit `sessionId` always wins over `reuseSession`, which is then
  stored as `false` with a notice.
- **Session capture**: when `reuseSession` is true and no `sessionId` is set, the adapter decides
  eligibility from the finished run's parsed result and resolves a session id, persisted onto
  both the run record and the job definition.
- **Claude resume safety**: a Claude session is reusable only after a complete result line was
  parsed. Before `--resume`, crontick checks a completed local run for that session id and that
  its transcript exists; otherwise the run fails with `SESSION_NOT_FOUND` before any process
  starts.
- **promptFile sugar**: CLI/programmatic input may use `promptFile` as creation sugar, read once
  at creation time; only `prompt` is ever persisted or exported.

## Further reading

- [Jobs](./jobs.md) - the job model and its action
- [Scheduling](./scheduling.md) - how ticks are generated
- [Error model](./error-model.md) - how failures surface to users
- [State and storage](./state-and-storage.md) - where runs and logs are stored
