# Execution

Audience: users and contributors reasoning about how a run actually happens. Non-duplication:
for the exact spawn/redaction/adoption mechanics see
[internals/prompt-execution.md](../internals/prompt-execution.md); for the engine adapter
contract see [internals/engines.md](../internals/engines.md); for the normative contract see
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
[internals/engines.md](../internals/engines.md)) into a concrete command/args/env, then spawns it
with `shell: false`, stdin ignored, and `detached: true, windowsHide: true` -- except when the
resolved command is `pwsh`/`powershell.exe` on Windows, which is spawned attached because
Windows's detached process creation gives the child no console and PowerShell's host needs one to
write output at all (see [ADR 0020](../decisions/0020-no-detach-powershell-script-jobs-windows.md)).
Detaching otherwise means a daemon restart or crash never kills a running job's process as a side
effect -- it keeps running (picked up by
[orphan reconciliation](./daemon-lifecycle.md#what-happens-while-the-daemon-is-down)) or has
already exited. The child's `pid` is persisted onto its run row as soon as known.

The child inherits `action.cwd` if set, otherwise `process.cwd()`. Environment merges (highest
wins): `action.env` > `envFile` variables > engine-config `env` > `process.env`.

## Log streams and capture

Each run's logs combine **engine streams** (`stdout`/`stderr`: the job process's own output) and
a **crontick stream** (its own lifecycle events -- run started, executing, run finished, overlap
skips, retry backoffs, session capture). Log retrieval accepts a `source` filter (`all` default,
`engine`, or `crontick`) across every surface, and logs are also mirrored, best-effort, to a
per-job file at `<dataDir>/logs/<jobId>.log` (see
[configuration reference](../reference/configuration.md#loggingconfig)).

Both streams are captured chunk-by-chunk through `safeRedact()`, which redacts secrets only in
valid UTF-8 text (binary passes through as-is). Output per run is bounded by
`retention.maxOutputBytesPerRun` (default 2,000,000 bytes); once hit, crontick trims to a UTF-8
character boundary, appends a truncation marker, and stops persisting further chunks -- the
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

`missed` is an eighth terminal status, but never produced by this pipeline: it's recorded
directly by the daemon's startup missed-fire pass for a fire that had no run because the daemon
wasn't running. See
[daemon-lifecycle.md](./daemon-lifecycle.md#what-happens-while-the-daemon-is-down).

## Retry behavior

If `retry.max > 0`, the Runner loops up to `max + 1` attempts, sleeping `retry.backoffSec`
seconds between them, stopping early on `success`, `canceled`, or `timeout`.

## How prompt jobs differ

- **Engine resolution**: `action.engine` (or `config.defaultEngine`, the built-in `claude` engine
  unless changed) selects a configured engine, whose **adapter** turns it into a concrete
  invocation -- see [internals/engines.md](../internals/engines.md) and
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
- [State and storage](./state-and-storage.md) - where runs and logs are persisted
