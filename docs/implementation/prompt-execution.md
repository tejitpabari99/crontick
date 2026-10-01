# Prompt Execution

Implements: `src/daemon/runner.ts`, `src/daemon/prompt-session.ts`, `src/config.ts`
(`resolvePromptRunCommand`)

Audience: contributors changing the runner's spawn, capture, or restart-recovery mechanics.
Non-duplication: for the execution mental model (overlap, timeouts, log file) see
[concepts/execution.md](../concepts/execution.md); for the engine adapter contract see
[engines.md](./engines.md).

The `Runner` class spawns a job's prompt engine as a child process, enforcing overlap
policy, retry with backoff, timeout, and redacted log capture.

---

## Runner class

```ts
class Runner {
  private queues: Map<string, QueueEntry[]>;            // overlap=queue
  private activeAborts: Map<string, AbortController>;
  private activeRunIds: Map<string, string>;
  private adoptedPolls: Map<string, NodeJS.Timeout>;     // adoptRun() liveness polls

  constructor(spawnFn?: typeof spawn, logger?: Logger, maxOutputBytesPerRunOverride?: number, ...);
  async run(job: Job, runId: string, store: Store): Promise<void>;
  adoptRun(jobId: string, runId: string, pid: number, store: Store): void;
  cancelJob(jobId: string): boolean;
  cancelRun(runId: string): boolean;
}
```

`spawnFn` is injectable for tests. `run()` applies the overlap policy (skip/queue/cancel-previous,
see [concepts/execution.md](../concepts/execution.md#overlap-enforcement)), then `execute()` loops
up to `retry.max + 1` attempts, calling the private `spawn()` for each one.

## Resolving the invocation

`spawn()` re-reads the latest job from the store (a captured session id may have landed since
scheduling), then calls `resolvePromptRunCommand()` (`src/config.ts`), which resolves the named
engine, looks up its adapter, and returns `{ invocation, adapter, engineOptions }`. The runner
spawns `invocation.command`/`args` with `shell: false` and persists `invocation.sessionId`
(Claude's pre-assigned id) to the run row immediately, before attaching output listeners.

Before resolving, `validateActionCwd()` fails the run with `ACTION_CWD_INVALID` if
`action.cwd` is set but missing or not a directory -- this runs ahead of engine resolution so a
bad `cwd` never masquerades as a PATH failure.

## Environment construction

Priority (highest wins): `action.env` > `envFile` variables (`readEnvFileForAction`) >
engine-config `env` > `process.env`. Spawn options are `{ cwd: action.cwd ?? process.cwd(),
shell: false, signal, detached: !isWindowsPowerShellHost, windowsHide: true, stdio: ['ignore',
'pipe', 'pipe'] }` -- stdin is always ignored.

## Detached-child exception

Every spawn passes `detached: true, windowsHide: true`, except when `isPowerShellHostCommand()`
detects the resolved command's basename is `pwsh`/`powershell` **and** the platform is Windows,
where `detached: false` instead -- Windows's `DETACHED_PROCESS` flag gives the child no console,
and a console-less PowerShell host never writes to its own stdout/stderr. This is keyed off the
spawned command's basename, not an action kind, so it would still apply if a configured engine's
command happened to be PowerShell. See [ADR 0001](../decisions/0001-architecture-and-runtime-model.md).

## Timeout enforcement

`action.timeoutSec` is enforced by the runner's own `setTimeout`, not Node's `spawn(...,
{ timeout })` option (indistinguishable from a plain `SIGTERM` cancellation once it fires). A
`timedOut` flag set just before the runner's own `SIGTERM` lets the `close` handler record
`status: 'timeout'` instead of the generic `canceled` a plain signal produces.

## Terminal errors, kill escalation, and guaranteed finalization

`EngineAdapter.detectTerminalError(line)` is called for every complete stdout line. The Claude adapter reports a `result` event with `is_error: true` and an assistant message carrying an authentication API error (401, `authentication_error`, invalid OAuth token). On detection the runner starts a `TERMINAL_ERROR_SETTLE_MS` (2s) timer. A healthy engine exits within it and the normal close path finalizes the run with its real exit code; otherwise `settleTerminal()` finalizes the run `failed` with the parsed message (and `noRetry` for authentication failures), releases the active-run lock, and terminates the process tree through the injectable `TreeKiller` (`src/daemon/process-tree.ts`: `taskkill /PID <pid> /T /F` on Windows, `process.kill(-pid)` on POSIX where children lead their own process group), then force-kills after `KILL_GRACE_MS` (5s).

The same guards cover timeouts and cancels (SIGTERM, then a forced tree kill, then finalization even without `close`) and a process that exits while a grandchild keeps its stdio open (finalized `EXIT_CLOSE_GRACE_MS` after `exit`). The Claude `SessionEnd` hook is unrelated to the hang: it only writes a marker file and cannot block or veto exit; crontick additionally sets a 10s hook `timeout` so it can never hold up shutdown.

## Stream capture, redaction, and the output cap

crontick never persists the engine's raw stdout/stderr (the runner keeps its own transcript).
`RunLogWriter` holds each redacted engine chunk in memory (bounded by the output cap) so that, when
the run is finalized, `parseEngineOutput()` can store only the parsed output (`store.setRunOutput()`,
the `run_outputs` table). Its other job is crontick's own events: `crontick()` appends one
timestamped, run-id-tagged line per event to the per-job log file (`JobLogFileFactory`,
injectable; sanitizes the job id and never blocks or fails a run on a write error). `safeRedact()` applies `redactText()` only to valid
UTF-8 chunks; binary data is not redacted. Once a run's captured bytes would exceed
`retention.maxOutputBytesPerRun`, the runner trims the final chunk to a UTF-8 character boundary
(`truncateToUtf8Boundary()`, scanning back up to 4 bytes), appends one truncation marker, sets
`outputTruncated`, and silently drops all further chunks -- the child process itself is never
signaled or throttled by hitting the cap.

## Session ID capture

When `reuseSession && !sessionId` and the run finishes, the adapter's `canCaptureSession(result)`
decides eligibility (raw: any success; Claude: only a parsed complete result). On success,
`adapter.resolveSessionId()` supplies the id, which is persisted onto the run record and, via
`store.tryCapturePromptSession()`, onto the job definition for future runs. Failure to resolve an
id fails the run with `SESSION_ID_NOT_FOUND`. For Claude, `adapter.resumeTranscriptPath()` plus
`store.hasCompletedClaudeSession()` gate an explicit `sessionId` before spawn --
`SESSION_NOT_FOUND` if either check fails. See [engines.md](./engines.md) for adapter details.

## Adopting runs across a restart

`adoptRun(jobId, runId, pid, store)` re-attaches a run that
[orphan reconciliation](./storage.md#orphan-reconciliation) found still alive (or inconclusive)
from a previous daemon process into this daemon's overlap tracking, so `overlap: 'skip'`/
`'cancel-previous'` still hold for it. Since there is no in-process `ChildProcess` handle, it
polls liveness every `ADOPTED_RUN_POLL_MS` (3000 ms) via `isSameRunProcess()` (re-verified on
every tick, not just once, to catch pid reuse mid-poll) instead of listening for `'exit'`. Once
the process is gone, it finalizes the run: a valid Claude completion marker
(`readClaudeCompletionMarker`) determines `success`/`failed` and exit code; otherwise it falls
back to `ADOPTED_RUN_EXITED_MESSAGE`. `cancelRun`/`cancelJob` on an adopted run sends `SIGTERM`
directly to the recorded `pid`, since there is no `AbortController`-driven spawn to abort.

## Process liveness

`src/process-liveness.ts`'s `createProcessLivenessCheck()` does **one bulk OS query per check instance** (`ps -eo
pid,lstart` on POSIX, one `Get-Process` PowerShell call on Windows), not one spawn per pid --
this is what keeps startup reconciliation fast with many in-flight runs. A pid missing from the
bulk snapshot falls back to a single-pid query. `withinStartTolerance()` compares the OS-reported
process start time against the run's recorded `startedAt` **symmetrically** (either direction, not
just "too early") within `PID_START_TOLERANCE_MS` (2000 ms), so a pid reused by an unrelated
process after the original exited is treated as dead rather than falsely adopted. Any internal
failure resolves to `undefined` (inconclusive), never throws.

## Diagnostic logging

When `logger.isDebugEnabled()`, the runner writes `[debug]` lines to the per-job log file via
`appendDiagnosticLog()`, visible there (`Log file:` in `crontick runs get <runId>`) when verbose was active during
the run.
