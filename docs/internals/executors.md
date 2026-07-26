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

### Script actions (`action.kind === 'script'`)

1. Resolve shell: `resolveShell(action.shell ?? 'auto')` -> `'pwsh'` on Windows,
   `'bash'` elsewhere, or explicit `'cmd'`.
2. Write script to a temp file in `os.tmpdir()/crontick/<uuid><ext>`:
   - `.ps1` for pwsh, `.bat` for cmd, `.sh` for bash.
   - Mode `0o700`.
3. Build command:
   - pwsh: `pwsh -NoProfile -NonInteractive -File <tmpFile>`
   - cmd: `cmd /c <tmpFile>`
   - bash: `bash <tmpFile>`
4. Temp file is deleted in `finally` block.

### Exec actions (`action.kind === 'exec'`)

Direct, verbatim: `cmd = action.command`, `args = action.args ?? []`. No shell, no quoting, no
whitespace splitting — `action.args` is the array the CLI's `--` separator (or the library API's
`args` field) already produced, so an argument containing a space or a shell metacharacter is
passed through to the child exactly as given. See
[concepts/execution.md](../concepts/execution.md#exec-jobs) and
[cli.md](../reference/cli.md#new) for the user-facing `--exec ... -- <args>` syntax.

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

`spawn` options: `{ cwd: action.cwd ?? process.cwd(), shell: false, signal, detached: true,
windowsHide: true }`. `detached` and `windowsHide` are always set, on every platform — see
[Detached Child Processes](#detached-child-processes) below. `child.pid` is written to the run's
`pid` column via `store.updateRun()` as soon as the process spawns, before any output arrives.

---

## Env File Parsing (`parseEnvFile`)

Exported from `src/daemon/runner.ts`. Parses `.env`-style files:
- Lines starting with `#` are comments.
- `KEY=VALUE` format; quotes (`"` or `'`) are stripped from values.
- Empty lines are skipped.

---

## Timeout Enforcement

`spawnOpts.timeout = action.timeoutSec * 1000` is passed to Node.js `spawn`.
Node emits an `'error'` event with `code === 'ETIMEDOUT'` which the runner maps
to `status: 'timeout'`.

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

1. The chunk is truncated to whatever headroom remains and persisted.
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
to Node's `spawn()`, identically on every platform. This means the child is started in its own
process group (POSIX) or its own process (Windows), decoupled from the daemon's process tree,
and `windowsHide` suppresses the console window Windows would otherwise flash for a detached
process.

The reason is restart safety: previously, spawn options differed by platform, which meant a
daemon restart could kill in-flight job processes as a side effect on one platform while leaving
them running-but-orphaned on the other. Detaching consistently means a daemon restart never
kills a running job's process as a side effect, on any platform — the process either keeps
running (and is picked up by [orphan reconciliation](./storage.md#orphan-reconciliation) and
`adoptRun()` above) or has already exited on its own. See
[ADR 0016](../decisions/0016-detached-children-cross-platform.md) for the full rationale and
tradeoffs.

---

## Process Liveness

`src/process-liveness.ts` (`createProcessLivenessCheck()`) provides the `isRunAlive(pid,
startedAt)` check used by [orphan reconciliation](./storage.md#orphan-reconciliation) and by the
adoption poll above:

- `isProcessAlive(pid)`: sends signal `0` to the pid; `EPERM` (permission denied, but the pid
  exists) still counts as alive.
- `getProcessStartTime(pid)`: reads the process's actual start time — `Get-Process` via
  PowerShell on Windows, `ps -o lstart=` on POSIX. Returns `undefined` if the platform call
  fails or the pid does not resolve to a process.
- `PID_START_TOLERANCE_MS` (2000ms): the recorded `runs.started_at` for an adopted run is
  compared to the live process's actual start time within this tolerance. A live pid whose
  start time differs by more than the tolerance is a **different process that reused the pid**
  after the original one exited — the check treats this as dead (`false`), not alive, defending
  reconciliation against pid-reuse false positives.
- Any failure inside the check (unexpected platform error, parse failure) is caught and
  surfaced as `undefined` — inconclusive, never thrown — so a liveness check can never itself
  crash the daemon's startup sequence.

---

## Diagnostic Logging

When `logger.isDebugEnabled()`, the runner writes `[crontick:debug]` lines to
the run's stderr log via `appendDiagnosticLog()`. These are visible in
`crontick logs <runId>` when verbose mode was active during the run.
