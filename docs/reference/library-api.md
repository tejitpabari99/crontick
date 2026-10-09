# Library API Reference

Public TypeScript API surface exported from the `crontick` package.

## Import Specifiers

```ts
import { createClient, CrontickClient, ... } from 'crontick';
```

Supported `package.json#exports`:

| Specifier | Resolves to |
|-----------|-------------|
| `"crontick"` (`.`) | `./dist/index.js` (types: `./dist/index.d.ts`) |
| `"crontick/package.json"` | `./package.json` |

---

## Classes

### CrontickClient

The primary API class. All operations are exposed as methods on this class.

```ts
class CrontickClient {
  constructor(options?: CrontickClientOptions);
}
```

#### Methods

Every method below that takes an `id` parameter (`getJob`, `updateJob`, `deleteJob`, `enableJob`, `disableJob`, `runNow`, `statsJob`, the `jobId` filter on `listRuns`) accepts EITHER the job's immutable GUID `id` OR its **alias** (the unique kebab-case job name; CLI `--alias`/`-a`) — an exact GUID match is tried first, falling back to an alias lookup. An identifier that resolves to neither throws `CrontickError('JOB_NOT_FOUND', 'Job X not found (id or alias)')`. See [job-schema.md](job-schema.md#identity-guid-id--alias) for how `id`/`alias` are assigned.

| Method | Signature | Returns | Throws |
|--------|-----------|---------|--------|
| `ensure` | `(): Promise<DaemonInfo>` | `DaemonInfo` | `CrontickError` (`DAEMON_START_FAILED`, `DAEMON_TIMEOUT`, `DAEMON_START_LOCK_TIMEOUT`) |
| `health` | `(options?: { ensure?: boolean }): Promise<unknown>` | Health response | `CrontickError` |
| `createJob` | `(input: Job \| JobCreateInput, options?: CreateJobOptions): Promise<Job>` | Created `Job` | `CrontickError` (`VALIDATION_ERROR`, `INVALID_CWD`, `TRUST_REQUIRED`, `CLAUDE_CONFIG_UNREADABLE`, `JOB_ALREADY_EXISTS`, `ENV_FILE_ERROR`, `DAEMON_REQUEST_FAILED`) |
| `createJobFromCliOptions` | `(input: JobCreateCliOptions): Promise<Job>` | Created `Job` | `CrontickError` |
| `listJobs` | `(): Promise<Job[]>` | Array of `Job` | `CrontickError` |
| `getJob` | `(id: string): Promise<Job>` | `Job` | `CrontickError` (`JOB_NOT_FOUND`) |
| `updateJob` | `(id: string, patch: JobPatchInput, options?: UpdateJobOptions): Promise<Job>` | Updated `Job` | `CrontickError` (`VALIDATION_ERROR`, `INVALID_CWD`, `CWD_CHANGE_BREAKS_SESSION`, `TRUST_REQUIRED`, `ENV_FILE_ERROR`, `JOB_NOT_FOUND`, `RUNS_IN_FLIGHT`, `INVALID_IN_FLIGHT_CHOICE`, `DAEMON_REQUEST_FAILED`) |
| `deleteJob` | `(id?: string, options?: { all?: boolean; force?: boolean }): Promise<{ ok: true; canceledRun: boolean; deletedRuns: number } \| { ok: true; deleted: number }>` | `{ ok, canceledRun, deletedRuns }` for a single delete (the job's runs, logs and schedule state are deleted with it), or `{ ok: true, deleted }` when `all` is set (requires `force`) | `CrontickError` (`VALIDATION_ERROR`, `JOB_NOT_FOUND`) |
| `enableJob` | `(id: string): Promise<Job>` | Updated `Job` | `CrontickError` |
| `disableJob` | `(id: string): Promise<Job>` | Updated `Job` | `CrontickError` |
| `runNow` | `(id: string): Promise<{ runId: string }>` (runs once now, even if disabled; does not enable the job or alter the schedule) | `{ runId }` | `CrontickError` |
| `cancelRun` | `(runId: string): Promise<{ ok: true; canceled: boolean }>` | Cancel result | `CrontickError` |
| `getRun` | `(runId: string): Promise<RunRecord>` | Run object | `CrontickError` |
| `listRuns` | `(options?: { jobId?: string; limit?: number; since?: number; status?: string }): Promise<RunRecord[]>` | Array of runs | `CrontickError` |
| `deleteRuns` | `(options: { runIds?: string[]; job?: string; dryRun?: boolean }): Promise<{ deleted: string[]; skipped: Array<{ id: string; status: string }>; notFound: string[]; jobLogRemoved: boolean }>` (exactly one of `runIds` or `job`; `job` is an id, an alias, or the raw id of an already-deleted job; `queued`/`running` runs are skipped and reported, never canceled; `dryRun` returns the same shape without deleting; no confirmation prompt, the CLI prompts. If the job no longer exists and no runs remain, its per-job log is removed (`jobLogRemoved`); a live job's log is kept) | `{ deleted, skipped, notFound, jobLogRemoved }` | `CrontickError` (`VALIDATION_ERROR` for neither/both inputs) |
| `getOutput` | `(runId: string): Promise<RunOutput>` (cleaned output view; library-only, shown by `crontick runs get` and `crontick_run_get`; the file of crontick-side events is `getRun().logFile`; crontick stores no raw engine log) | `RunOutput` | `CrontickError` (`NOT_FOUND`) |
| `exportJobs` | `(options?: { onlyJobs?: string[] }): Promise<ExportFile>` | Share file `{ schema: 1, exportedAt, crontickVersion, jobs }` (jobs only, ids omitted) | `CrontickError` (`JOB_NOT_FOUND` listing every unknown `onlyJobs` entry) |
| `importJobs` | `(file: unknown, options?: NormalizeJobInputOptions & { trustFolder?: boolean }): Promise<ImportResult>` | `{ imported, results }`; each row `{ id, alias, ok, renamedFrom?, error? }`. Every job gets a new GUID, alias collisions get `-2`, `-3`, ... | `CrontickError` (`VALIDATION_ERROR` for a bad file or wrong `schema`, nothing imported; `TRUST_REQUIRED`) |
| `validateSchedule` | `(schedule: Schedule): Promise<unknown>` | Validation result | `CrontickError` |
| `previewSchedule` | `(input: { schedule: Schedule; n?: number }): Promise<unknown>` | Fire times | `CrontickError` |
| `jobSchedule` | `(id: string, options?: { n?: number }): Promise<unknown>` | Upcoming fire times for an existing job (id or alias); returns `{ jobId, alias, enabled, cwd, schedule, next }`; powers `crontick jobs schedule` and `crontick_job_schedule` | `CrontickError` (`JOB_NOT_FOUND`) |
| `statsSummary` | `(): Promise<StatsSummary>` | `StatsSummary` | `CrontickError` |
| `statsJob` | `(id: string): Promise<JobStats>` | `JobStats` | `CrontickError` |
| `daemonStart` | `(options?: { foreground?: boolean; home?: string }): Promise<DaemonStartResult>` | Start result (library-only after round-2 simplification) | `CrontickError` |
| `daemonStop` | `(): Promise<DaemonStopResult>` | Stop result — see [DaemonStopResult](#daemonstopresult) | `CrontickError` |
| `daemonRestart` | `(): Promise<DaemonRestartResult>` | `{ ok: true, baseUrl, port?, pid?, started, stopped, previousPid? }` — library-only after round-2 simplification; the stop phase escalates internally the same way as `daemonStop`, but only `stopped`/`previousPid` are surfaced (no `mode`/`activeRuns`) | `CrontickError` |
| `daemonReload` | `(): Promise<{ ok: true }>` | `{ ok: true }` | `CrontickError` |
| `daemonPause` | `(): Promise<{ ok: true; paused: true }>` | Pause scheduling; due fires are recorded `skipped`; in-memory, not persisted | `CrontickError` |
| `daemonResume` | `(): Promise<{ ok: true; paused: false }>` | Resume scheduling | `CrontickError` |
| `daemonStatus` | `(): Promise<DaemonStatus>` | `DaemonStatus` — library-only after round-2 simplification | `CrontickError` |
| `doctor` | `(options?: DoctorOptions): Promise<DoctorResult>` | `DoctorResult` | `CrontickError` |
| `dashboardStatus` | `(): Promise<DashboardStatus>` | `DashboardStatus` — library-only; the dashboard is served by the daemon | `CrontickError` |
| `dashboardData` | `(options?: DashboardOptions): Promise<DashboardData>` | `DashboardData` — library-only; the dashboard is served by the daemon | `CrontickError` |
| `jobJsonSchema` | `(): unknown` | JSON Schema object | — |
| `getConfig` | `(): CrontickConfig` | `CrontickConfig` | `CrontickError` |
| `configList` | `(): ConfigListResult` | `{ path, revision, config, stored, readOnly, notice }` — redacted effective config plus redacted stored keys; file-direct, works with the daemon down | `CrontickError` |
| `configGet` | `(key: string): unknown` | Value at a dotted key of the redacted effective config | `CrontickError` (`CONFIG_KEY_NOT_FOUND`) |
| `configSet` | `(key: string, value: unknown, options?: ConfigWriteOptions): Promise<ConfigWriteResult>` | `{ path, config, stored, changed, revision, notice, reload, warnings }` — `reload` is `reloaded`, `daemon-not-running` (no daemon is started) or `failed` (saved anyway, plus a warning). `engines.<name>` set adds or replaces an engine | `CrontickError` (`CONFIG_CONFLICT`, `CONFIG_KEY_READ_ONLY`, `RUNS_IN_FLIGHT`, validation codes) |
| `configUnset` | `(key: string, options?: ConfigWriteOptions): Promise<ConfigWriteResult>` | Same as `configSet`. `unset engines.<name>` removes an engine; with a daemon up, a warning lists jobs still using it (the save is not blocked) | same |
| `initConfig` | `(options?: { force?: boolean }): { path: string; config: CrontickConfig; created: boolean }` | Init result | `CrontickError` (`CONFIG_EXISTS`) |
| `validateConfig` | `(path?: string): ConfigValidationResult` | Validation result | `CrontickError` |
| `configPath` | `(): ConfigPathInfo` | `{ path, note }` — library-only helper mirrored by `info().configPath` | — |
| `info` | `(): Promise<CrontickInfo>` | `{ version, node, platform, configPath, configExists, paths: CrontickInfoPaths, daemon: { running, pid?, port?, portNote? }, dashboardUrl }` (`CrontickInfoPaths` = `dataDir`, `jobsDir`, `runsDb`, `logsDir`, `configFile`, `portFile`, `pidFile`; `configExists: false` means built-in defaults are in use) — powers `crontick info` and `crontick_info`; `dashboardUrl` is the daemon-served dashboard URL when running, otherwise `null` | `CrontickError` |
| `autostartEnable` | `(): Promise<AutostartEnableResult>` (register the daemon to start at login; idempotent; no daemon needed) | `{ enabled: true, mechanism, definitionPath, hints }` | `CrontickError` (`AUTOSTART_UNSUPPORTED`, `AUTOSTART_UNAVAILABLE`, `AUTOSTART_SCRIPT_MISSING`, `AUTOSTART_EPHEMERAL_PATH`, `AUTOSTART_FAILED`) |
| `autostartDisable` | `(): Promise<AutostartDisableResult>` (idempotent) | `{ removed, mechanism? }`; `removed: false` when nothing was registered | `CrontickError` (`AUTOSTART_UNSUPPORTED`, `AUTOSTART_UNAVAILABLE`, `AUTOSTART_FAILED`) |
| `autostartStatus` | `(): Promise<AutostartStatus>` (never throws for an unsupported platform) | `{ supported, enabled, mechanism?, definitionPath?, command?, active?, stale, staleReasons, reason?, hints }` | `CrontickError` |
| `drainNotices` | `(): string[]` | Accumulated notices | — |
| `isVerbose` | `(): boolean` | Verbose flag | — |

`RunRecord` includes optional `costUsd`, `turns`, `usageJson`, `transcriptPath`, and `engineStatus` for Claude runs with a complete result. `usageJson` is the redacted raw usage block serialized as JSON. `getRun` also returns `logFile`, the absolute path of the per-job log file (crontick-side lifecycle events of all runs of the job, one file per job, no engine output; `null` when file logging is off). `getLogs` and its types (`LogsResult`, `LogEntry`, `LogSource`, `LOG_SOURCES`) were removed; `crontick runs get` and `crontick_run_get` show the cleaned output and this path instead. `sessionId` is displayed as the Runner Session ID. The stored `command` shows `--settings <session-end-hook>` rather than the hook JSON. Raw-engine runs omit these fields. Run status `skipped` means an overlap fire never started; `canceled` means a run was terminated. `StatsSummary` and `JobStats` include separate `canceled` and `skipped` counts, plus `totalCostUsd` and `totalTurns`, summing runs with recorded usage and treating missing values as zero. `JobStats` covers every retained run of the job; `totalTurns` is the sum of `turns` (Claude `num_turns`, the agentic model round-trips of a run, accumulated across retries). `lastRunAt` stays epoch milliseconds (the CLI prints it as local ISO-8601).

**Library-only methods (retained in the client but no longer part of `SURFACE_CAPABILITIES`, so they have no CLI/MCP equivalent):** `ensure`, `health`, `createJobFromCliOptions`, `jobJsonSchema`, `getConfig`, `drainNotices`, `isVerbose`, `daemonStart`, `daemonStatus`, `daemonRestart`, `configPath`, `validateSchedule`, `previewSchedule`, `dashboardStatus`, `dashboardData`, and the config helpers `initConfig` and `validateConfig` (`configList`/`configGet`/`configSet`/`configUnset` are parity capabilities). These are intentionally excluded from the parity contract because they serve internal wiring, direct-use library scenarios, or launch infrastructure rather than proxying a daemon operation exposed on every surface. The `dashboard` command group and MCP tools were removed because the dashboard is always served by the daemon; `dashboardStart`/`dashboardStop` were removed entirely (they only made sense as commands), while `dashboardStatus`/`dashboardData` remain for direct library use.

Read methods that surface config values or captured text (`configList`, `configGet`, `getRun`,
`listRuns`, and `dashboardData`) apply the shared redaction contract before
returning strings or structured text fields. Job-returning methods (`createJob`, `listJobs`,
`getJob`, and `updateJob`) and config mutators (`configSet` and `configUnset`) also redact secret-like env/config values
in their returned objects without changing the response schema. The same contract applies
on CLI, MCP, and HTTP read surfaces: common provider tokens, `token=`/`******
assignments, contextual or nearby-access-key-paired AWS secret-access-key values, and private keys
(including lone PEM markers) are redacted, while benign key names such as `NON_SECRET`
remain visible.

`createJob()` and `updateJob()` also preflight `action.envFile` before persistence. If
the file is missing or unreadable, they reject with `ENV_FILE_ERROR`, resolve relative
paths against `action.cwd` when set (otherwise the caller's current working directory),
and leave previously stored job state unchanged.

**Clearing optional fields.** In a `JobPatchInput` passed to `updateJob`, `null` removes a field: `description`, `action.timeoutSec` and `action.sessionId` accept `null` (e.g. `updateJob(id, { description: null, action: { kind: 'prompt', timeoutSec: null } })`). No other field can be nulled; omitting a field leaves it unchanged. The CLI exposes the same through `jobs update --unset <field>`, MCP through `crontick_job_update`.

**Working directory and Claude trust.** A job runs in `action.cwd`, which `createJob`/`updateJob`/`importJobs` resolve to an absolute, existing directory (`INVALID_CWD` otherwise); an omitted cwd on create defaults to the client's `cwd` option, else `process.cwd()`. For Claude jobs the client checks Claude's trust config (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`) before persisting anything and throws `TRUST_REQUIRED` (`details: { cwd, folders, engine }`) for an untrusted folder unless `trustFolder: true` is passed, in which case it records the trust first. Only the `hasTrustDialogAccepted` flag of that folder is written; all other keys are preserved and an unparsable file aborts with `CLAUDE_CONFIG_UNREADABLE`. `updateJob` checks only when the cwd or engine changes; engines without a trust concept (raw) are skipped. Changing the cwd of a job with a session throws `CWD_CHANGE_BREAKS_SESSION`. `claude -p` itself skips Claude's trust dialog, so this is a guardrail rather than a hard requirement.

Cron expressions fire in the machine's local timezone; passing `tz` is rejected on create/update input, and a `tz` in an already-stored job file is silently ignored.

---

### CrontickError

```ts
class CrontickError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown);
  toJSON(): { code: string; message: string; details?: unknown };
}
```

See [errors.md](errors.md) for all known codes.

---

## Factory Functions

### createClient

```ts
function createClient(options?: CrontickClientOptions): CrontickClient;
```

> Exit guidance: after daemon-backed calls, prefer `process.exitCode = n` and let Node exit
> naturally instead of calling `process.exit(n)` immediately. The client now uses a short-lived
> `node:http` transport to avoid the historical Windows native crash, but natural exit remains the
> recommended library-consumer pattern.

---

## Interfaces

### CrontickClientOptions

```ts
interface CrontickClientOptions {
  daemonUrl?: string;
  daemonScript?: string;
  startDaemon?: boolean;        // default: true
  startupTimeoutMs?: number;
  healthTimeoutMs?: number;
  lockTimeoutMs?: number;
  requestTimeoutMs?: number;    // default: 30000
  cwd?: string;
  mcpScript?: string;
  verbose?: boolean;
  env?: NodeJS.ProcessEnv;
  onLog?: LogSink;
  logger?: Logger;
}
```

### StatsSummary

```ts
interface StatsSummary {
  totalJobs: number;
  enabledJobs: number;
  succeeded: number;
  failed: number;
  canceled: number;
  skipped: number;
  avgDurationSec: number | null;
  totalCostUsd: number;
  totalTurns: number;
}
```

`canceled` counts runs that started and were terminated; `skipped` counts fires that never started because overlap `skip` found another run active. `totalCostUsd` and `totalTurns` sum the included runs; runs without usage contribute zero.

`avgDurationSec` is the average of `durationMs` (in seconds, 2 decimals) over runs that actually finished executing --
`success`/`failed`/`timeout` -- and excludes `missed`, `queued`, `running`, `canceled`, and `skipped` runs,
since those either never ran to completion or never ran at all. `null` when there are no
qualifying runs. These summary counts include only runs whose parent job still exists: deleting a
job removes its runs, so they no longer count toward live aggregate totals. Same computation backs [`DashboardStats`](#dashboardstats) (`GET
/api/stats/summary` and the dashboard both call `buildDashboardStats()`).

### JobStats

```ts
interface JobStats {
  jobId: string;
  succeeded: number;
  failed: number;
  canceled: number;
  skipped: number;
  lastStatus: string | null;
  lastRunAt: number | null;
  avgDurationSec: number | null;
  totalCostUsd: number;
  totalTurns: number;
}
```

### RunRecord

```ts
interface RunRecord {
  id: string;
  jobId: string;
  startedAt: number;
  endedAt?: number;
  status: string; // queued | running | success | failed | canceled | skipped | timeout | missed
  exitCode?: number;
  error?: string;
  durationMs?: number;
  pid?: number;
  outputTruncated: boolean;
  sessionId?: string;
  command?: string;          // redacted resolved command line
  costUsd?: number;          // Claude runs with a complete result
  turns?: number;
  usageJson?: string;        // redacted raw usage block, JSON string
  logFile?: string | null;   // getRun() only: absolute per-JOB log file (all runs appended); null when logging.fileEnabled=false
  logFileExists?: boolean;   // getRun() only: whether logFile exists on disk (set when logFile is non-null)
  transcriptExists?: boolean; // getRun() only: whether transcriptPath exists on disk (set when transcriptPath is set)
  transcriptPath?: string;
  engineStatus?: string;     // Claude result subtype
}
```

The last five fields are populated only for Claude runs with a complete `stream-json` result line; raw-engine runs omit them. See [job-schema.md](job-schema.md#run-statuses) for status meanings.

### NormalizeJobInputOptions

```ts
interface NormalizeJobInputOptions {
  cwd?: string;
  fileBaseDir?: string;
  maxPromptFileBytes?: number;    // default: 1048576 (1 MiB)
  env?: NodeJS.ProcessEnv;
  onNotice?: (message: string) => void;
}
```

### CreateJobOptions

```ts
interface CreateJobOptions extends NormalizeJobInputOptions {
  force?: boolean;
  trustFolder?: boolean; // trust the job's cwd in Claude when not trusted yet (else TRUST_REQUIRED)
}

interface UpdateJobOptions extends NormalizeJobInputOptions {
  trustFolder?: boolean;
  /** Runs in flight for this job: 'stop' cancels them (and drops queued ones) then applies; 'wait' pauses the job, applies after they finish, then resumes. Omitted with runs in flight -> RUNS_IN_FLIGHT (details.runs). */
  inFlight?: 'stop' | 'wait';
}
```

`force` intentionally replaces an existing job with the same id. When omitted or
`false`, `createJob()` rejects duplicates with `JOB_ALREADY_EXISTS`.

### JobCreateCliOptions

```ts
interface JobCreateCliOptions {
  alias?: string;
  engineArgs?: string[];
  rawArgs?: string[];
  passthroughArgs?: string[];
  cliArgvOrder?: string[];
  args?: string[];
  file?: string;
  cron?: string;
  every?: number;
  at?: string;
  cwd?: string;
  trustFolder?: boolean;
  prompt?: string;
  promptFile?: string;
  engine?: string;
  sessionId?: string;
  reuseSession?: boolean;
  envFile?: string;
  timeout?: number;
  overlap?: string;
  retry?: number;
  desc?: string;
  enabled?: boolean;
  enable?: boolean;
  disable?: boolean;
  force?: boolean;
}
```

### JobPatchCliOptions

```ts
type JobPatchCliOptions = JobCreateCliOptions;
```

`createJobFromCliOptions()` inherits the CLI file-loading behavior: `input.file` accepts
UTF-8 JSON with an optional leading BOM, malformed JSON throws `VALIDATION_ERROR` with
`details` containing `path`, `position`, `line`, `column`, and an expected-shape hint,
and `envFile` is preflighted before persistence the same way as `createJob()`/`updateJob()`.

### DaemonStopResult

```ts
interface DaemonStopResult {
  ok: true;
  running: boolean;
  pid?: number;
  stopped: boolean;
  message: string;
  mode: 'already-stopped' | 'graceful' | 'hard-kill';
  activeRuns?: Array<{ id: string; jobId: string }>;
}
```

Returned by `daemonStop` (`CrontickClient`) and by `crontick daemon stop`. `mode` reports how the daemon was actually stopped: `'graceful'` if the
`POST /api/daemon/stop` route accepted the request and the process exited before the poll
timeout; `'hard-kill'` if that stalled or the route was unreachable and `stopDaemon()` had to
escalate to `SIGTERM` then `SIGKILL`; `'already-stopped'` if no daemon was running. `activeRuns`
lists any runs still `status: 'running'` at the moment the stop was accepted — they are not
canceled by a stop, since [detached children survive daemon shutdown by design](../concepts/daemon-lifecycle.md#what-happens-while-the-daemon-is-down)
(PowerShell-hosted commands retain the exception described in [ADR 0001](../decisions/0001-architecture-and-runtime-model.md)).
See [cli.md](./cli.md#crontick-info-daemon-stop) and [implementation/daemon.md](../implementation/daemon.md#shutdown).

### DaemonRestartResult

```ts
interface DaemonRestartResult extends DaemonInfo { // { baseUrl, port?, pid?, started }
  ok: true;
  stopped: boolean;
  previousPid?: number;
}
```

Returned by the library-only `daemonRestart()` helper. The stop phase (`stopDaemon()`) runs the
same graceful-then-escalate sequence as [`DaemonStopResult`](#daemonstopresult), but only
`stopped` (whether the previous daemon actually exited) and `previousPid` are surfaced here —
`mode` and `activeRuns` are not part of this result.

### DaemonStatus

```ts
interface DaemonStatus {
  pid: number;
  version: string;
  port: number;
  baseUrl: string;
  uptimeSec: number;
  jobs: number;
  missedFires: {
    jobsWithMissedFires: number;
    missedRunsRecorded: number;
    jobsCapped: number;
    capPerJob: number;
  };
}
```

Returned by the library-only `daemonStatus()` helper; it also carries `dashboardUrl` and `portNote` (`started on fallback port N; default 47615 is in use`, else `null`). `crontick info` / `crontick_info` expose the lighter `{ running, pid?, port? }` daemon summary instead. `baseUrl` is always the daemon's loopback listener URL
(`http://127.0.0.1:<port>`), so scripts can discover the daemon endpoint without reading internal
state files.

### DashboardOptions

```ts
interface DashboardOptions {
  runsLimit?: number;
  jobId?: string;
  /** Restrict runs to any of these job ids. */
  jobIds?: string[];
  /** Restrict runs to any of these statuses. */
  statuses?: RunStatus[];
  /** Substring search over run id, status, error, session id, job id/alias and stored run output. */
  q?: string;
}
```

### DashboardData

```ts
interface DashboardData {
  generatedAt: number;
  health: DashboardHealth;
  stats: DashboardStats;
  jobs: DashboardJob[];
  runs: DashboardRun[];
}
```

### DashboardHealth

```ts
interface DashboardHealth {
  ok: true;
  product: 'crontick';
  version: string;
  uptimeSec: number;
  pid: number;
  port: number;
  node: string;
  platform: string;
  jobs: { total: number; enabled: number };
  runs: { last24h: number; failures24h: number };
}
```

### RunOutput

Returned by `getOutput`, shown by `crontick runs get <runId>` (`--json` prints `{ run, output }`) and `crontick_run_get`, and served at `GET /api/runs/:id/output`.

```ts
interface RunOutput {
  runId: string;
  status: string;
  format: 'claude-stream-json' | 'text'; // how engine stdout was parsed
  result: string | null;   // the engine's final answer (Claude `result` event text, else plain stdout for text engines)
  error: string | null;    // run.error, else an error reported in the engine output
  logFile?: string | null; // per-job file of crontick-side events (all runs of the job), null when file logging is off; set by the daemon route
  stderr: string;          // engine stderr, redacted (capped at 1,000,000 bytes per run)
  sessionId: string | null;
  costUsd: number | null;
  turns: number | null;
  durationMs: number | null;
  usage: NormalizedUsage | null; // display-only token counts parsed from usageJson; null when none
  truncated: boolean;      // a text engine's stdout hit the retention cap
}
```

`NormalizedUsage` is `{ inputTokens?, outputTokens?, cacheReadTokens?, cacheCreationTokens?, thinkingTokens? }`; fields are `undefined` when missing or non-numeric. It reads the run-total counters of Claude's usage block and ignores `iterations[]`. Cost (`costUsd`) is Claude-reported `total_cost_usd`, not computed by crontick.

Only the final `result` event and stderr are kept (tool calls, interim assistant text, thinking and system events are discarded as the stream arrives), with secret redaction applied. crontick does not store the engine's raw logs: the runner keeps its own transcript (`transcriptPath`), and `logFile` holds only crontick's own events.

### DashboardStats

```ts
interface DashboardStats {
  totalJobs: number;
  enabledJobs: number;
  succeeded: number;
  failed: number;
  canceled: number;
  skipped: number;
  avgDurationSec: number | null;
  totalCostUsd: number;
  totalTurns: number;
}
```

Same shape and computation as [`StatsSummary`](#statssummary) -- see there for how
`avgDurationSec` is averaged and how deleted-job history is excluded from live aggregates.
`DashboardData.runs` likewise lists only runs whose parent job still exists.

### DashboardJob

```ts
interface DashboardJob {
  id: string;
  description: string | null;
  enabled: boolean;
  scheduleLabel: string;
  actionKind: 'prompt';
  lastStatus: string | null;
  lastRunAt: number | null;
  avgDurationSec: number | null;
  nextRunAt: string | null;
  job: Job;
}
```

### DashboardRun

```ts
interface DashboardRun {
  id: string;
  jobId: string;
  /** The referenced job's alias at snapshot time; null if the job has no alias. */
  jobAlias: string | null;
  status: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  exitCode: number | null;
  error: string | null;
  /** Prompt-engine session id captured for this run; null when none. */
  sessionId: string | null;
}
```

### DashboardStatus

```ts
interface DashboardStatus {
  ok: true;
  running: boolean;
  url: string;
  port?: number;
  pid?: number;
  daemon: unknown;
}
```

### SurfaceCapability

```ts
interface SurfaceCapability {
  capability: string;
  clientMethod: string;
  cliCommand: string[];
  mcpTool: string;
}
```

### AutostartStatus, AutostartEnableResult, AutostartDisableResult

Exported types for the autostart methods. `AutostartStatus` is `{ supported: boolean; enabled: boolean; mechanism?: string; definitionPath?: string; command?: string; active?: boolean; stale: boolean; staleReasons: string[]; reason?: string; hints: string[] }`. `stale` is true when the registered node path, daemon script path or `CRONTICK_HOME` differs from what `autostartEnable()` would write now. `AutostartEnableResult` is `{ enabled: true; mechanism: string; definitionPath: string; hints: string[] }` and `AutostartDisableResult` is `{ removed: boolean; mechanism?: string }`.

For custom or test backends the module also exports `AutostartBackend`, `AutostartSpec`, `AutostartDeps`, `AutostartFs`, `AutostartExecResult`, `BackendInspection` and `AutostartMechanism`, and `CrontickClientOptions.autostartDeps` injects the OS access (platform, env, home directory, `exec`, fs) so nothing touches the real service manager.

Autostart is opt-in and library/CLI-only for enable/disable; `daemon start` (`daemonStart`) never registers anything. Lifecycle caveat: without systemd linger, jobs pause while the user is fully logged out.

### Logger

```ts
interface Logger {
  readonly level: LogLevel;
  readonly verbose: boolean;
  isEnabled(level: LogLevel): boolean;
  isDebugEnabled(): boolean;
  child(component: string): Logger;
  log(level: LogLevel, message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
}
```

### LoggerOptions

```ts
interface LoggerOptions {
  verbose?: boolean;
  level?: LogLevel;
  component?: string;
  sink?: LogSink;
}
```

### LogEvent

```ts
interface LogEvent {
  ts: string;
  level: LogLevel;
  component?: string;
  message: string;
  data?: unknown;
}
```

---

## Types

### LogLevel

```ts
type LogLevel = 'error' | 'warn' | 'info' | 'debug';
```

### LogSink

```ts
type LogSink = (event: LogEvent) => void;
```

### Job, JobInput, Schedule, Action, PromptAction, PromptEngine

See [job-schema.md](job-schema.md).

### CrontickConfig, EngineConfig

See [configuration.md](configuration.md).

### RetentionConfig

```ts
type RetentionConfig = z.infer<typeof RetentionConfigSchema>; // { maxRunsPerJob: number; maxOutputBytesPerRun: number; maxLogFiles: number }
```

See [configuration.md](configuration.md#retentionconfig).

### JobCreateInput, JobPatchInput, ActionInput, PromptActionInput

See [job-schema.md](job-schema.md).

---

## Standalone Functions

### createLogger

```ts
function createLogger(options?: LoggerOptions): Logger;
```

### isVerboseEnv

```ts
function isVerboseEnv(env?: NodeJS.ProcessEnv): boolean;
```

Returns `true` if `CRONTICK_VERBOSE` matches `1|true|yes|on|debug` (case-insensitive).

### nullLogger

```ts
const nullLogger: Logger;
```

A logger at `error` level with no sink (discards all output).

### redactText

```ts
function redactText(text: string): string;
```

Replaces common secret patterns (provider tokens/keys, JWT-like bearer blobs, private
keys, key/value secret assignments, and connection-string passwords) with
`[REDACTED]`.

### redactValue

```ts
function redactValue(value: unknown, keyHint?: string): unknown;
```

Recursively redacts secret-like strings from objects and arrays. Keys matching the
shared secret-key matcher (for example `token`, `secret`, `password`, `api_key`,
`authorization`, or `subscription_key`) are fully replaced.

### sanitizeLogEvent

```ts
function sanitizeLogEvent(event: LogEvent): LogEvent;
```

Returns a copy with message and data redacted.

### buildJobFromCreateOptions

```ts
function buildJobFromCreateOptions(input: JobCreateCliOptions, options?: NormalizeJobInputOptions): Job;
```

### buildJobPatchFromUpdateOptions

```ts
function buildJobPatchFromUpdateOptions(input: JobPatchCliOptions, options?: NormalizeJobInputOptions): JobPatchInput;
```

### applyConfigDefaults

```ts
function applyConfigDefaults(job: Job, options?: NormalizeJobInputOptions): Job;
```

Fills `action.engine` from config `defaultEngine` if unset on prompt actions. Engine `type` (`claude` or `raw`) selects the adapter used by `buildPromptRunCommand()`.

### normalizeJobInput

```ts
function normalizeJobInput(input: JobCreateInput, options?: NormalizeJobInputOptions): Job;
```

On creation, omitted overlap, retry, and timeout values are copied from
`config.defaults` into the stored job; later config edits do not rewrite it.

### normalizeJobPatch

```ts
function normalizeJobPatch(id: string, existing: Job, patch: JobPatchInput, options?: NormalizeJobInputOptions): Job;
```

### generateAlias

```ts
function generateAlias(isTaken: (candidate: string) => boolean, options?: GenerateAliasOptions): string;
```

Auto-generates a unique job alias (`<word>-<1-1000>`, retrying on collision) when the caller doesn't supply one on create. `isTaken` should check the candidate against both existing job ids and aliases. `options.words` and `options.random` are injectable (default to `DEFAULT_ALIAS_WORDS` and `Math.random`) so callers/tests can control the output deterministically. Throws `CrontickError('ALIAS_GENERATION_FAILED', ...)` if no unique candidate is found after 50 attempts.

```ts
interface GenerateAliasOptions {
  words?: readonly string[]; // defaults to DEFAULT_ALIAS_WORDS
  random?: () => number;     // defaults to Math.random; must return a float in [0, 1)
}
```

### DEFAULT_ALIAS_WORDS

```ts
const DEFAULT_ALIAS_WORDS: readonly string[];
```

The built-in word list `generateAlias` draws from by default.

### JOB_ALIAS_PATTERN

```ts
const JOB_ALIAS_PATTERN: RegExp; // /^[a-z0-9]+(?:-[a-z0-9]+)*$/
```

The kebab-case pattern a job's `alias` must match when supplied.

### jobJsonSchema

```ts
function jobJsonSchema(): unknown;
```

Returns the JSON Schema (object) generated from `JobSchema` via `zod-to-json-schema`.

### jobJsonSchemaText

Exported from `src/schema-json.ts`; the JSON Schema as a formatted string.

`ConfigWriteOptions` = `{ ifRevision?: string; inFlight?: 'stop' | 'wait' }`. `ifRevision` rejects with `CONFIG_CONFLICT` when the file changed since it was read. `inFlight` applies only when a daemon is up and runs are in flight (otherwise `RUNS_IN_FLIGHT`). The superseded `getConfigValue`, `setConfigValue`, `removeConfigValue`, `listEngines`, `addEngine`, `updateEngine`, `removeEngine` exports were removed.

### Config Functions

```ts
function configFilePath(options?: ConfigOptions): string;
function loadConfig(options?: ConfigOptions): CrontickConfig;
function readConfigFile(options?: ConfigOptions): CrontickConfig | null;
function writeConfigFile(config: unknown, options?: ConfigOptions): CrontickConfig;
function initConfig(options?: InitConfigOptions): { path: string; config: CrontickConfig; created: boolean };
function validateConfigFile(options?: ConfigOptions): ConfigValidationResult;
function buildPromptRunCommand(action: PromptAction, options?: ConfigOptions): PromptRunCommand;
```

`loadConfig()`, `readConfigFile()`, and `validateConfigFile()` accept UTF-8 JSON with an
optional leading BOM. Malformed config JSON produces `CONFIG_READ_ERROR` with `details`
that include `path`, `position`, `line`, `column`, and `expectedShape`. Returned config
values are redacted using the same shared read-surface contract described above.

---

## Constants

### VERSION

```ts
const VERSION: string;
```

Build-time injected version from `package.json` (currently `"0.2.0"`).

### BUILT_IN_CONFIG

```ts
const BUILT_IN_CONFIG: CrontickConfig;
```

```json
{ "defaultEngine": "claude", "engines": { "claude": { "command": "claude", "args": [], "env": {}, "type": "claude" } }, "retention": { "maxRunsPerJob": 100, "maxOutputBytesPerRun": 2000000, "maxLogFiles": 30 }, "logging": { "fileEnabled": true }, "maxConsecutiveFailures": 3, "defaults": { "overlap": "skip", "retry": { "max": 0, "backoffSec": 30 } } }
```

### SURFACE_CAPABILITIES

```ts
const SURFACE_CAPABILITIES: readonly SurfaceCapability[];
```

27-element array mapping every capability to its client method, CLI command path, and
MCP tool name. The existing `create-job` capability row also records its parity-coupled
`force` option via `optionNames: ['force']`.

### ORPHAN_RUN_ERROR_CODE

```ts
const ORPHAN_RUN_ERROR_CODE: string; // 'DAEMON_RESTART'
```

The stable code prefix stored in `runs.error` when `Store.reconcileOrphanRuns()` cancels a
`queued` run (never spawned) or a `running` run confirmed dead by a process-liveness check, left
behind by a daemon restart. A `running` run whose process is still alive (or the liveness check
was inconclusive) is adopted instead and does not get this error — see
[storage internals](../implementation/storage.md#orphan-reconciliation). Not a thrown `CrontickError`
code — see [errors.md](errors.md#stored-run-error-values-not-crontickerror-codes).

### ORPHAN_RUN_ERROR_MESSAGE

```ts
const ORPHAN_RUN_ERROR_MESSAGE: string;
// 'DAEMON_RESTART: run was canceled because the daemon restarted while it was queued or running'
```

The full stored `runs.error` value written by `reconcileOrphanRuns()`.

---

## Schemas (Zod)

| Export | Type | Description |
|--------|------|-------------|
| `JobSchema` | `z.ZodObject` | Full job schema |
| `ScheduleSchema` | `z.ZodDiscriminatedUnion` | Schedule discriminated union |
| `PromptActionSchema` | `z.ZodObject` with refinement | Prompt action with runtime validation |
| `PromptEngineSchema` | `z.ZodString` | Engine name regex |
| `ConfigSchema` | `z.ZodObject` | Config file schema |
| `EngineConfigSchema` | `z.ZodObject` | Single engine config |
| `RetentionConfigSchema` | `z.ZodObject` | `{ maxRunsPerJob: number; maxOutputBytesPerRun: number; maxLogFiles: number }`, `.strict()`, defaults `100`/`2_000_000`/`30` |
