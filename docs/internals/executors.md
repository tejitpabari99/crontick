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
  cancelJob(jobId: string): boolean;
  cancelRun(runId: string): boolean;
}
```

The `spawnFn` parameter allows injection of a mock `spawn` for tests.

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

Direct: `cmd = action.command`, `args = action.args ?? []`.

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

`spawn` options: `{ cwd: action.cwd ?? process.cwd(), shell: false, signal }`.

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
2. Call `store.appendLog(runId, stream, redactedChunk)`.

Prompt session capture: stdout/stderr chunks are also appended to a
`transcriptTail` buffer (max 128 KB, ring-style) for session ID extraction.

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

---

## Diagnostic Logging

When `logger.isDebugEnabled()`, the runner writes `[crontick:debug]` lines to
the run's stderr log via `appendDiagnosticLog()`. These are visible in
`crontick logs <runId>` when verbose mode was active during the run.
