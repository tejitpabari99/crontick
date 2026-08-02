# Executors

Implements: `src/daemon/runner.ts`, `src/daemon/prompt-session.ts`, `src/config.ts` (buildPromptRunCommand)

The `Runner` class executes job actions as child processes, enforcing overlap
policies, retry with backoff, timeout, and log capture with redaction.

---

## Runner Class

```ts
// src/daemon/runner.ts
class Runner {
  private queues: Map<string, QueueEntry[]>;       // overlap=queue
  private activeAborts: Map<string, AbortController>;
  private activeRunIds: Map<string, string>;
  private draining: Set<string>;

  constructor(spawnFn?: typeof spawn, logger?: Logger);
  async run(job: Job, runId: string, store: Store): Promise<void>;
  adoptRun(jobId: string, runId: string, pid: number, store: Store): void;
  cancelJob(jobId: string): boolean;
  cancelRun(runId: string): boolean;
}
```

The `spawnFn` parameter allows injection of a mock `spawn` for tests.

---

## Adopting Runs Across a Restart

`adoptRun(jobId, runId, pid, store)` re-attaches a run that `Store.reconcileOrphanRuns()`
determined is still alive in a previous daemon's child process (see
[storage.md](./storage.md#orphan-reconciliation)) into this daemon's in-memory overlap tracking:

- The run's `jobId`/`runId` are registered in `activeRunIds` exactly as a freshly-spawned run
  would be, so a subsequent fire for the same job still observes `overlap: 'skip'` or
  `overlap: 'cancel-previous'` correctly instead of treating the adopted run as untracked.
- Since the daemon does not hold the original `ChildProcess` handle (it was created by a
  different process), `adoptRun` polls liveness every `ADOPTED_RUN_POLL_MS` (3000ms) using the
  same process-liveness check (see [Process Liveness](#process-liveness) below) instead of
  listening for an `'exit'` event, and finalizes the run (`status`, `ended_at`, `duration_ms`)
  once the poll observes the process has exited.
- `cancelRun`/`cancelJob` on an adopted run sends `SIGTERM` directly to the recorded `pid`
  (there is no `AbortController`-driven `spawn` to abort), since the daemon does not own the
  child's stdio streams to signal it another way.

This is what makes `overlap: 'skip'` and `overlap: 'cancel-previous'` hold across a daemon
restart instead of only within a single daemon process's lifetime — see
[concepts/execution.md](../concepts/execution.md#overlap-policies).

---

## Overlap Policies

Determined by `job.overlap` (default `'skip'`):

| Policy | Behavior |
|--------|----------|
| `skip` | If a run is active for this job, immediately cancel the new run with error `overlap=skip`. |
| `cancel-previous` | Abort the active run's `AbortController`, then execute the new run. |
| `queue` | Enqueue the run. A drain loop processes entries sequentially per job. |

Active state is tracked per-job in `activeAborts` and `activeRunIds`. The maps
are only cleared if they still point to the completing run (prevents races when
`cancel-previous` overwrites them).

---

## Execution Flow

`execute(job, runId, store)`:

1. Mark run as `'running'` in store.
2. Create `AbortController`; register in `activeAborts`/`activeRunIds`.
3. Loop up to `retry.max + 1` attempts:
   - If not first attempt, sleep `retry.backoffSec * 1000` ms.
   - Check abort signal before each retry.
   - Call `this.spawn(job, runId, store, signal)`.
   - Break on `success`, `canceled`, or `timeout`.
4. Finalize run with `updateRun(status, exitCode, error, endedAt, durationMs)`.

---

## Spawn Details

Before any child process is spawned, the runner pre-validates `action.cwd` for **all** action kinds. When `action.cwd` is set but the path does not exist, or resolves to something other than a directory, the runner fails the run immediately with `ACTION_CWD_INVALID: <kind> action cwd ...`, names the rejected path, and suggests updating `action.cwd` before the next run. This happens before prompt-engine command resolution, so a missing directory cannot masquerade as a prompt-engine PATH failure.

### Script actions (`action.kind === 'script'`)

1. Resolve shell: `resolveShell(action.shell ?? 'auto')` -> `'pwsh'` on Windows,
   `'bash'` elsewhere, or explicit `'cmd'`.
2. Write script to a managed temp file in `<dataDir>/tmp/scripts/<uuid><ext>` (`CRONTICK_HOME`-scoped):
   - `.ps1` for pwsh, `.bat` for cmd, `.sh` for bash.
   - PowerShell also writes a sibling `<uuid>.user.ps1` file there, then runs a wrapper `.ps1`.
   - Mode `0o700`.
3. Build command:
   - pwsh: `pwsh -NoProfile -NonInteractive -File <tmpFile>`
   - cmd: `cmd /c <tmpFile>`
   - bash: `bash <tmpFile>`
4. Every wrapper/user-script file is deleted in the runner's `finally` block (best-effort, regardless of run outcome).

### Exec actions (`action.kind === 'exec'`)

Direct, verbatim: `cmd = action.command`, `args = action.args ?? []`. No shell, no quoting, no
whitespace splitting — `action.args` is the array the CLI's repeatable `--arg <value>` flag (or,
as a convenience, the `--` separator; or the library API's `args` field) already produced, so an
argument containing a space or a shell metacharacter is passed through to the child exactly as
given. See [concepts/execution.md](../concepts/execution.md#exec-jobs) and
[cli.md](../reference/cli.md#new) for the user-facing `--arg`/`--` syntax.

### Prompt actions (`action.kind === 'prompt'`)

1. Re-read the latest job from store (session ID may have been captured).
2. Call `buildPromptRunCommand(action, { logger })` from `src/config.ts`:
   - Resolves engine from config (`action.engine ?? config.defaultEngine`).
   - Builds args: `[...engine.args, action.prompt, ...action.args]`.
   - Appends `--session-id=<id>` if `action.sessionId` is set.
   - Returns `{ command, args, env, engine }`.
3. If `reuseSession && !sessionId`: enable transcript capture for session ID
   extraction after successful exit.

---

## Environment Construction

Priority (highest wins):

1. `action.env` (explicit per-job env vars)
2. `envFile` variables (parsed by `parseEnvFile()`)
3. `promptEnv` (from engine config `engine.env`)
4. `process.env` (inherited)

`spawn` options: `{ cwd: action.cwd ?? process.cwd(), shell: false, signal, detached:
!isWindowsPowerShellHost, windowsHide: true }`. The runner reaches this point only after the
shared `action.cwd` preflight above succeeds; otherwise the run finalizes `failed` before any
spawn attempt occurs. `detached` is always set except for the one
`pwsh`/`powershell.exe`-on-Windows exception — see
[Detached Child Processes](#detached-child-processes) below. `windowsHide` is always set,
regardless. `child.pid` is written to the run's `pid` column via `store.updateRun()` as soon as
the process spawns, before any output arrives.

---

## Env File Parsing (`parseEnvFile`)

Exported from `src/daemon/runner.ts`. Parses `.env`-style files:
- Lines starting with `#` are comments.
- `KEY=VALUE` format; quotes (`"` or `'`) are stripped from values.
- Empty lines are skipped.

---

## Timeout Enforcement

`action.timeoutSec` is enforced by the runner itself, not by Node's `spawn(..., { timeout })`
option (which cannot be distinguished from a plain SIGTERM cancellation once it fires). A
`setTimeout(action.timeoutSec * 1000)` runs alongside the spawn; if it fires before the child has
already exited, the runner sets an internal `timedOut` flag and sends `SIGTERM` to the child
directly. The `close` handler checks `timedOut` before the generic signal check and records
`status: 'timeout'` with `error: 'run exceeded timeoutSec (${action.timeoutSec}s)'`, instead of
the generic `canceled` that a plain signal produces.

---

## Stream Capture and Redaction

`child.stdout` and `child.stderr` `'data'` events:

1. Call `safeRedact(chunk)`: if the chunk is valid UTF-8 (no NUL bytes, lossless
   round-trip), apply `redactText()` from `src/logger.ts` to strip secrets.
   Binary data passes through unmodified.
2. Enforce the per-run output cap (see [Output Capture Cap](#output-capture-cap) below) before
   the chunk is persisted.
3. Call `store.appendLog(runId, stream, redactedChunk)`.

Prompt session capture: stdout/stderr chunks are also appended to a
`transcriptTail` buffer (max 128 KB, ring-style) for session ID extraction.

---

## Output Capture Cap

Each run tracks a running byte total across both `stdout` and `stderr`. Once that total would
exceed `retention.maxOutputBytesPerRun` (default `2_000_000`, range `1024..1_000_000_000` — see
[configuration.md](../reference/configuration.md#retentionconfig)):

1. The chunk is truncated to whatever headroom remains, then trimmed back further if needed so
   the truncation point falls on a valid UTF-8 character boundary
   (`truncateToUtf8Boundary()` — scans back up to 4 bytes, the longest possible UTF-8 sequence, to
   avoid ever persisting a split multi-byte character right before the marker), and persisted.
2. A single truncation marker line is appended to the captured output (once — not repeated on
   every subsequent chunk).
3. The run's `output_truncated` column is set to `1`, surfaced to callers as `outputTruncated:
   true` (see [cli.md](../reference/cli.md#logs) and [mcp-tools.md](../reference/mcp-tools.md)).
4. All further `stdout`/`stderr` data for that run is dropped without being written to
   `run_logs` — capture stops, but the cap is re-read live on `crontick daemon reload`, so a
   config change takes effect for runs started after the reload.

Capping output only stops *capture*; the child process itself is never signaled, killed, or
otherwise affected by hitting the cap — a job that produces gigabytes of stdout still runs to
completion and exits normally, it just does not have all of that output recorded.

---

## Session ID Capture

When `reuseSession && !sessionId` and the run succeeds:

1. `extractSessionId(transcriptTail)` in `src/daemon/prompt-session.ts` applies
   regex patterns against the last 128 KB of combined output.
2. On match: `store.tryCapturePromptSession(jobId, action, sessionId)` persists
   the session ID into the job definition for future runs.
3. On failure: the run is marked `failed` with error `SESSION_ID_NOT_FOUND`.

---

## Cancellation

- `cancelRun(runId)`: iterates `activeRunIds` to find the job, then aborts.
- `cancelJob(jobId)`: aborts the `AbortController` in `activeAborts`.
- Aborted processes receive `SIGTERM`/`SIGKILL` via Node.js abort semantics.
- Cancelling an *adopted* run (see [Adopting Runs Across a Restart](#adopting-runs-across-a-restart))
  has no `AbortController` to abort — the runner sends `SIGTERM` directly to the recorded `pid`
  instead.

---

## Detached Child Processes

Every spawn — script, exec, and prompt actions alike — passes `detached: true, windowsHide: true`
to Node's `spawn()`, with one narrow exception: `isPowerShellHostCommand(cmd)` returns true when
the resolved command's basename (case-insensitive, `.exe` suffix optional) is `pwsh` or
`powershell`; when that is true **and** `platform() === 'win32'`, `detached` is set to `false`
instead. This covers `script` jobs whose resolved shell is PowerShell, including the
`shell: "auto"` default on Windows.

The reason for the exception: Node's `detached: true` maps to Win32's `DETACHED_PROCESS` creation
flag, which gives the child no console at all. PowerShell's own host requires an attached console
to initialize, and without one it never reaches the point of writing to its (otherwise valid)
stdout/stderr handles — verified empirically with both pipe- and file-redirected stdio, both come
back completely empty. `cmd.exe` and `node.exe` are unaffected by the same `detached: true` spawn.
A diagnostic log line (`'detached disabled for pwsh/powershell.exe on Windows (output-capture
trade-off, see runner.ts)'`) is appended to the run's own output whenever the exception applies.

For every other command/platform combination, detaching means the child is started in its own
process group (POSIX) or its own process (Windows), decoupled from the daemon's process tree, and
`windowsHide` suppresses the console window Windows would otherwise flash for a detached process.

The reason for detaching at all is restart safety: previously, spawn options differed by
platform, which meant a daemon restart could kill in-flight job processes as a side effect on one
platform while leaving them running-but-orphaned on the other. Detaching consistently means a
daemon restart never kills a running job's process as a side effect (except, deliberately, for
the PowerShell case above) — the process either keeps running (and is picked up by
[orphan reconciliation](./storage.md#orphan-reconciliation) and `adoptRun()` above) or has already
exited on its own. See [ADR 0016](../decisions/0016-detached-children-cross-platform.md) for the
original rationale and [ADR 0020](../decisions/0020-no-detach-powershell-script-jobs-windows.md)
for the PowerShell exception and its trade-off.

---

## Process Liveness

`src/process-liveness.ts` (`createProcessLivenessCheck()`) provides the `isRunAlive(pid,
startedAt)` check used by [orphan reconciliation](./storage.md#orphan-reconciliation) and by the
adoption poll above:

- `isProcessAlive(pid)`: sends signal `0` to the pid; `EPERM` (permission denied, but the pid
  exists) still counts as alive.
- `getProcessStartTime(pid)`: reads a single process's actual start time (fallback path) —
  `Get-Process` via PowerShell on Windows, `ps -o lstart=` on POSIX. Returns `undefined` if the
  platform call fails or the pid does not resolve to a process.
- **Bulk listing, not one spawn per pid.** `createProcessLivenessCheck()` does one bulk OS query
  total per check instance (lazy, cached on first `isRunAlive` call), not one `spawnSync` per pid:
  `bulkWindowsStartTimes()` runs a single `Get-Process | ForEach-Object {...}` PowerShell
  invocation, and `bulkPosixStartTimes()` runs a single `ps -eo pid,lstart`. A pid missing from
  the bulk result (e.g. it was created after the snapshot) falls back to the single-pid
  `getProcessStartTime()`. This is what keeps startup reconciliation fast when many runs need to
  be checked at once — previously one `spawnSync` per pid made Windows startup with many
  in-flight runs noticeably slow.
- `withinStartTolerance(a, b)` / `PID_START_TOLERANCE_MS` (2000ms): the recorded
  `runs.started_at` for an adopted run is compared to the live process's actual start time within
  this tolerance, **symmetrically** (`Math.abs(a - b) <= tolerance`) — a live pid whose start time
  differs from the recorded `startedAt` by more than the tolerance, in either direction, is
  treated as a **different process that reused the pid** after the original one exited, not the
  original run's process, defending reconciliation against pid-reuse false positives. (An
  earlier, one-sided version of this check only rejected a start time *before* the tolerance
  window, which could never actually catch a reused pid, since a reused pid's process necessarily
  starts *after* the original one exited.)
- `isSameRunProcess(pid, startedAt)` combines `isProcessAlive` and `withinStartTolerance` into one
  answer (`true`/`false`/`undefined` for inconclusive). `Runner.adoptRun()`'s poll calls this on
  **every tick**, not just once at initial reconciliation, so an adopted run whose pid gets reused
  by an unrelated process while the poll is still running is caught and treated as exited, rather
  than the poll trusting `isProcessAlive(pid)` alone indefinitely.
- Any failure inside the check (unexpected platform error, parse failure) is caught and
  surfaced as `undefined` — inconclusive, never thrown — so a liveness check can never itself
  crash the daemon's startup sequence.

---

## Diagnostic Logging

When `logger.isDebugEnabled()`, the runner writes `[crontick:debug]` lines to
the run's stderr log via `appendDiagnosticLog()`. These are visible in
`crontick logs <runId>` when verbose mode was active during the run.
