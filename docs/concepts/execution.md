# Execution

After reading this page you will understand how crontick turns a scheduled tick into a completed run, including process spawning, I/O capture, timeouts, and how prompt jobs differ.

## From tick to run

1. The scheduler emits a `tick` event with `{ jobId, plannedAt }`.
2. The daemon handler fetches the job from the store; if the job is missing or disabled, the tick is dropped.
3. A new run is inserted into SQLite with status `queued` and `startedAt` set to the planned time.
4. `Runner.run()` is called with the job, run ID, and store reference.

## Overlap enforcement

Before spawning, the Runner checks the job's `overlap` policy:

- **skip**: if another run for this job is active, the new run is immediately finalized as `canceled`.
- **cancel-previous**: the active run's `AbortController` is signaled, then the new run proceeds.
- **queue**: the new run is placed in a per-job FIFO queue; a drain loop executes entries sequentially.

Overlap state (which run is active per job, and its queue) is tracked in the daemon process's
memory, not persisted to `runs.db`. A daemon restart drops that in-memory state, but it is
rebuilt for any run that survived the restart: on startup, `Store.reconcileOrphanRuns()`
liveness-checks each `running` run's recorded `pid` and, if the process is still alive (or
liveness can't be ruled out), calls `Runner.adoptRun()` to re-register it in the new process's
overlap tracking, so a `skip`/`cancel-previous` policy still holds for that job. See
[daemon-lifecycle.md](./daemon-lifecycle.md#what-happens-while-the-daemon-is-down) for the full
reconciliation behavior.

## Process spawn

All action kinds spawn a child process with `shell: false` using Node.js `child_process.spawn`. The spawn options are:

```typescript
{
  cwd: action.cwd ?? process.cwd(),
  env: { ...process.env, ...promptEnv, ...envFileVars, ...action.env },
  signal: abortController.signal,
  shell: false,
  timeout: action.timeoutSec ? action.timeoutSec * 1000 : undefined,
  detached: true,
  windowsHide: true,
}
```

`detached: true` is set for every action kind on every platform, so a child's survival across a
daemon restart or crash is uniform: on POSIX the child reparents to init as before; on Windows it
runs in its own process group instead of the daemon's job object, so it is no longer killed when
the daemon exits. `windowsHide` suppresses the console window that `detached` would otherwise
pop on Windows. The child's `pid` is persisted onto its run row (`Store.updateRun(runId, { pid })`)
as soon as it is known, and `child.unref()` is called so a detached child never keeps the daemon's
event loop alive. See [daemon-lifecycle.md](./daemon-lifecycle.md#what-happens-while-the-daemon-is-down)
for how a surviving child is reconciled on the next daemon start.

### Script jobs

The `script` body is written to a temporary file in `<os.tmpdir()>/crontick/` with extension `.sh`, `.ps1`, or `.bat` (depending on resolved shell). The appropriate interpreter is invoked:

| Shell | Command |
|-------|---------|
| `bash` | `bash <tmpfile>` |
| `pwsh` | `pwsh -NoProfile -NonInteractive -File <tmpfile>` |
| `cmd` | `cmd /c <tmpfile>` |

The temp file is deleted after the process exits (or on error).

### Exec jobs

The `command` is spawned directly with `args`. No shell interpretation occurs. `command` is used
verbatim -- it is never split on whitespace -- so a command string containing spaces (e.g. a path)
is passed through unchanged as a single argv element. `args` come from whatever a surface passes
through (for the CLI, everything after a literal `--`), so an individual argument containing
spaces is preserved intact rather than being re-split. See
[cli.md](../reference/cli.md#crontick-new) for the CLI's `--`-based syntax and its two
Windows shell-shim caveats, and [ADR 0018](../decisions/0018-exec-dash-dash-args.md) for why `--`
was chosen over whitespace splitting.

### Prompt jobs

The engine is resolved from `config.json`. `buildPromptRunCommand()` constructs the full command, arguments, and environment for the engine binary. The prompt text and any engine-specific args are passed as CLI arguments to the engine.

## Working directory

The child process inherits `action.cwd` if set; otherwise it defaults to `process.cwd()` of the daemon process (typically the daemon's install location).

## Environment inheritance

Environment variables are merged in priority order (last wins):

1. `process.env` (daemon's environment)
2. Engine-specific env (prompt jobs only, from `buildPromptRunCommand`)
3. `envFile` variables (parsed from a `.env`-style file)
4. `action.env` (inline env from the job definition)

The `envFile` is resolved relative to `action.cwd` (or `process.cwd()`) when not an absolute path.

## Stdout/stderr capture

Both streams are captured chunk-by-chunk. Each chunk passes through `safeRedact()`, which applies secret redaction only to valid UTF-8 text (binary data is stored as-is). Redacted chunks are inserted into `run_logs` with the stream name and a timestamp.

Captured output per run is bounded by `retention.maxOutputBytesPerRun` (default 2,000,000 bytes,
configurable `1024..1_000_000_000` -- see [configuration reference](../reference/configuration.md)).
Once a run's captured output reaches the cap, crontick appends a truncation marker line to
`run_logs` and stops persisting any further chunks; the run's `outputTruncated` field is set to
`true`. This only stops output *capture* -- the job's own child process is never killed,
throttled, or otherwise affected by hitting the cap; it keeps running to completion. See
[internals/executors.md](../internals/executors.md#output-capture-cap) for the exact enforcement
point.

## Timeouts

When `action.timeoutSec` is set, it is passed as `timeout` (in ms) to the spawn options. Node.js sends SIGTERM to the child on timeout. The Runner interprets the `ETIMEDOUT` error code as status `timeout`.

## Exit-status interpretation

| Condition | Run status |
|-----------|------------|
| Exit code 0 | `success` |
| Exit code non-zero | `failed` (with `exitCode` recorded) |
| Signal SIGTERM/SIGKILL | `canceled` |
| Abort signal (overlap or manual cancel) | `canceled` |
| ETIMEDOUT | `timeout` |
| ENOENT (prompt engine not found) | `failed` with descriptive error |
| No exit code (null) | `failed` |

`missed` is a seventh terminal status, but it is never produced by the Runner or by this
tick-to-run pipeline: it is recorded directly by the daemon's startup missed-fire pass for a
schedule fire that had no run at all because the daemon was not running at the time. See
[daemon-lifecycle.md](./daemon-lifecycle.md#what-happens-while-the-daemon-is-down).

## Retry behavior

If `retry.max > 0`, the Runner loops up to `max + 1` total attempts. Between retries it sleeps for `retry.backoffSec` seconds. Retries stop early on `success`, `canceled`, or `timeout`.

## How prompt jobs differ

Beyond the spawn mechanics, prompt jobs have additional behavior:

- **Engine resolution**: the configured engine is looked up from `config.json` using `action.engine` (or `defaultEngine` if omitted). The resulting command line follows the pattern: `<engine.command> <engine.args...> <prompt> <action.args...> [--session-id=<id>]`.
- **Session precedence**: explicit `sessionId` is used every run. If both `sessionId` and `reuseSession` are supplied, `sessionId` wins and crontick stores `reuseSession: false` with a notice.
- **Session capture**: when `reuseSession` is true and no `sessionId` is set, the Runner monitors the engine's combined stdout/stderr output (up to 128 KB tail) and extracts a session ID via regex after a successful exit. The captured ID is persisted back into the job definition so subsequent runs reuse the same session.
- **Engine resolution failure**: if the engine binary is not on PATH, the run fails with a descriptive error naming the engine and suggesting config changes.
- **promptFile sugar**: CLI and programmatic input may use `promptFile` as creation sugar. It must point to a UTF-8 `.txt` file; the file is read before persistence and exports contain only `prompt`.

## Finalization

After all attempts complete (or abort), `Runner.finalizeRun()` updates the SQLite run record with the final `status`, `exitCode`, `error`, `endedAt`, and `durationMs`.

## Further reading

- [Jobs](./jobs.md) - action kinds and overlap/retry fields
- [Scheduling](./scheduling.md) - how ticks are generated
- [Error model](./error-model.md) - how failures surface to users
- [State and storage](./state-and-storage.md) - where runs and logs are persisted
