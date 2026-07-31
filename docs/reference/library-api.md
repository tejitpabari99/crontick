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

| Method | Signature | Returns | Throws |
|--------|-----------|---------|--------|
| `ensure` | `(): Promise<DaemonInfo>` | `DaemonInfo` | `CrontickError` (`DAEMON_START_FAILED`, `DAEMON_TIMEOUT`, `DAEMON_START_LOCK_TIMEOUT`) |
| `health` | `(options?: { ensure?: boolean }): Promise<unknown>` | Health response | `CrontickError` |
| `createJob` | `(input: Job \| JobCreateInput, options?: CreateJobOptions): Promise<Job>` | Created `Job` | `CrontickError` (`VALIDATION_ERROR`, `JOB_ALREADY_EXISTS`, `ENV_FILE_ERROR`, `DAEMON_REQUEST_FAILED`) |
| `createJobFromCliOptions` | `(input: JobCreateCliOptions): Promise<Job>` | Created `Job` | `CrontickError` |
| `listJobs` | `(): Promise<Job[]>` | Array of `Job` | `CrontickError` |
| `getJob` | `(id: string): Promise<Job>` | `Job` | `CrontickError` (`NOT_FOUND`) |
| `updateJob` | `(id: string, patch: JobPatchInput, options?: NormalizeJobInputOptions): Promise<Job>` | Updated `Job` | `CrontickError` (`VALIDATION_ERROR`, `ENV_FILE_ERROR`, `NOT_FOUND`, `DAEMON_REQUEST_FAILED`) |
| `deleteJob` | `(id: string): Promise<{ ok: true; canceledRun: boolean }>` | `{ ok: true, canceledRun }` — `canceledRun` is `true` when the job had an in-flight run that was canceled as part of the delete | `CrontickError` (`NOT_FOUND`) |
| `enableJob` | `(id: string): Promise<Job>` | Updated `Job` | `CrontickError` |
| `disableJob` | `(id: string): Promise<Job>` | Updated `Job` | `CrontickError` |
| `runNow` | `(id: string): Promise<{ runId: string }>` | `{ runId }` | `CrontickError` |
| `cancelRun` | `(runId: string): Promise<{ ok: true; canceled: boolean }>` | Cancel result | `CrontickError` |
| `getRun` | `(runId: string): Promise<unknown>` | Run object | `CrontickError` |
| `listRuns` | `(options?: { jobId?: string; limit?: number; since?: number; status?: string }): Promise<unknown[]>` | Array of runs | `CrontickError` |
| `getLogs` | `(runId: string, options?: { lines?: number }): Promise<LogsResult>` | `LogsResult` | `CrontickError` |
| `exportJobs` | `(options?: { includeRuns?: boolean }): Promise<{ jobs: Job[]; runs?: unknown[] }>` | Export payload; `runs` present only when `includeRuns` is set | `CrontickError` |
| `importJobs` | `(jobs: unknown[], options?: NormalizeJobInputOptions & { runs?: unknown[] }): Promise<unknown>` | Import result, including `runsImported`/`runsSkipped` when `options.runs` is passed | `CrontickError` |
| `validateSchedule` | `(schedule: Schedule): Promise<unknown>` | Validation result | `CrontickError` |
| `previewSchedule` | `(input: { schedule: Schedule; n?: number; tz?: string }): Promise<unknown>` | Fire times | `CrontickError` |
| `statsSummary` | `(): Promise<StatsSummary>` | `StatsSummary` | `CrontickError` |
| `statsJob` | `(id: string): Promise<JobStats>` | `JobStats` | `CrontickError` |
| `daemonStart` | `(options?: { foreground?: boolean }): Promise<DaemonStartResult>` | Start result | `CrontickError` |
| `daemonStop` | `(): Promise<DaemonStopResult>` | Stop result — see [DaemonStopResult](#daemonstopresult) | `CrontickError` |
| `daemonRestart` | `(): Promise<DaemonRestartResult>` | `{ ok: true, baseUrl, port?, pid?, started, stopped, previousPid? }` — the stop phase escalates internally the same way as `daemonStop`, but only `stopped`/`previousPid` are surfaced (no `mode`/`activeRuns`) | `CrontickError` |
| `daemonReload` | `(): Promise<{ ok: true }>` | `{ ok: true }` | `CrontickError` |
| `daemonStatus` | `(): Promise<DaemonStatus>` | `DaemonStatus` | `CrontickError` |
| `doctor` | `(options?: DoctorOptions): Promise<DoctorResult>` | `DoctorResult` | `CrontickError` |
| `dashboardStart` | `(): Promise<DashboardStartResult>` | `DashboardStartResult` | `CrontickError` |
| `dashboardStop` | `(): Promise<DashboardStopResult>` | Stop result | `CrontickError` |
| `dashboardStatus` | `(): Promise<DashboardStatus>` | `DashboardStatus` | `CrontickError` |
| `dashboardData` | `(options?: DashboardOptions): Promise<DashboardData>` | `DashboardData` | `CrontickError` |
| `jobJsonSchema` | `(): unknown` | JSON Schema object | — |
| `getConfig` | `(): CrontickConfig` | `CrontickConfig` | `CrontickError` |
| `getConfigValue` | `(path?: string): unknown` | Config value | `CrontickError` (`CONFIG_KEY_NOT_FOUND`) |
| `setConfigValue` | `(path: string, value: unknown): CrontickConfig` | Updated config | `CrontickError` |
| `removeConfigValue` | `(path: string): CrontickConfig` | Updated config | `CrontickError` |
| `listEngines` | `(): Record<string, EngineConfig>` | Engines map | `CrontickError` |
| `addEngine` | `(name: string, engine: EngineConfig): CrontickConfig` | Updated config | `CrontickError` (`CONFIG_ENGINE_EXISTS`) |
| `updateEngine` | `(name: string, engine: Partial<EngineConfig>): CrontickConfig` | Updated config | `CrontickError` (`CONFIG_ENGINE_NOT_FOUND`) |
| `removeEngine` | `(name: string): CrontickConfig` | Updated config | `CrontickError` (`CONFIG_ENGINE_NOT_FOUND`, `CONFIG_BUILTIN_ENGINE`) |
| `initConfig` | `(options?: { force?: boolean }): { path: string; config: CrontickConfig; created: boolean }` | Init result | `CrontickError` (`CONFIG_EXISTS`) |
| `validateConfig` | `(path?: string): ConfigValidationResult` | Validation result | `CrontickError` |
| `drainNotices` | `(): string[]` | Accumulated notices | — |
| `isVerbose` | `(): boolean` | Verbose flag | — |

**Library-only methods (not in `SURFACE_CAPABILITIES`, no CLI/MCP equivalent):** `ensure`, `health`, `createJobFromCliOptions`, `jobJsonSchema`, `getConfig`, `drainNotices`, `isVerbose`. These are intentionally excluded from the parity contract because they serve internal wiring, direct-use library scenarios, or launch infrastructure rather than proxying a daemon operation.

Read methods that surface config values or captured text (`getConfigValue`, `getRun`,
`listRuns`, `getLogs`, and `dashboardData`) apply the shared redaction contract before
returning strings or structured text fields. Job-returning methods (`createJob`, `listJobs`,
`getJob`, and `updateJob`) and config mutators (`setConfigValue`, `removeConfigValue`,
`addEngine`, `updateEngine`, and `removeEngine`) also redact secret-like env/config values
in their returned objects without changing the response schema. The same contract applies
on CLI, MCP, and HTTP read surfaces: common provider tokens, `token=`/`******
assignments, contextual or standalone AWS secret-access-key values, and private keys
(including lone PEM markers) are redacted, while benign key names such as `NON_SECRET`
remain visible.

`createJob()` and `updateJob()` also preflight `action.envFile` before persistence. If
the file is missing or unreadable, they reject with `ENV_FILE_ERROR`, resolve relative
paths against `action.cwd` when set (otherwise the caller's current working directory),
and leave previously stored job state unchanged.

`getLogs({ lines: N })` reconstructs newline-delimited text lines from the ordered
stdout/stderr chunk rows returned by the daemon before applying the last-`N` slice, so
chunk boundaries do not change the visible tail result.

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

### LogEntry

```ts
interface LogEntry {
  runId?: string;
  stream: string;
  ts: number;
  data: string;
}
```

### LogsResult

```ts
interface LogsResult {
  runId: string;
  lines: LogEntry[];
}
```

### StatsSummary

```ts
interface StatsSummary {
  totalJobs: number;
  enabledJobs: number;
  totalRuns: number;
  succeeded: number;
  failed: number;
  avgDurationMs: number | null;
}
```

`avgDurationMs` averages `durationMs` over runs that actually finished executing --
`success`/`failed`/`timeout` -- and excludes `missed`, `queued`, `running`, and `canceled` runs,
since those either never ran to completion or never ran at all. `null` when there are no
qualifying runs. These summary counts include only runs whose parent job still exists: deleting a
job keeps its historical runs directly queryable by run id/logs, but removes those archived rows
from live aggregate totals. Same computation backs [`DashboardStats`](#dashboardstats) (`GET
/api/stats/summary` and the dashboard both call `buildDashboardStats()`).

### JobStats

```ts
interface JobStats {
  jobId: string;
  totalRuns: number;
  succeeded: number;
  failed: number;
  lastStatus: string | null;
  lastRunAt: number | null;
}
```

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
}
```

`force` intentionally replaces an existing job with the same id. When omitted or
`false`, `createJob()` rejects duplicates with `JOB_ALREADY_EXISTS`.

### JobCreateCliOptions

```ts
interface JobCreateCliOptions {
  id: string;
  engineArgs?: string[];
  rawArgs?: string[];
  args?: string[];
  file?: string;
  cron?: string;
  every?: number;
  at?: string;
  tz?: string;
  script?: string;
  exec?: string;
  prompt?: string;
  promptFile?: string;
  engine?: string;
  sessionId?: string;
  reuseSession?: boolean;
  shell?: string;
  envFile?: string;
  timeout?: number;
  overlap?: string;
  retry?: number;
  desc?: string;
  enabled?: boolean;
  force?: boolean;
}
```

### JobPatchCliOptions

```ts
type JobPatchCliOptions = Omit<JobCreateCliOptions, 'id'>;
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
(with one Windows exception, see [ADR 0020](../decisions/0020-no-detach-powershell-script-jobs-windows.md)).
See [cli.md](./cli.md#daemon-stop) and [internals/daemon.md](../internals/daemon.md#shutdown).

### DaemonRestartResult

```ts
interface DaemonRestartResult extends DaemonInfo { // { baseUrl, port?, pid?, started }
  ok: true;
  stopped: boolean;
  previousPid?: number;
}
```

Returned by `daemonRestart`/`crontick daemon restart`. The stop phase (`stopDaemon()`) runs the
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

Returned by `daemonStatus` (`CrontickClient`), `crontick daemon status`, and
`crontick_daemon_status`. `baseUrl` is always the daemon's loopback listener URL
(`http://127.0.0.1:<port>`), so scripts can discover the daemon endpoint without reading internal
state files.

### DashboardOptions

```ts
interface DashboardOptions {
  runsLimit?: number;
  jobId?: string;
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

### DashboardStats

```ts
interface DashboardStats {
  totalJobs: number;
  enabledJobs: number;
  totalRuns: number;
  succeeded: number;
  failed: number;
  avgDurationMs: number | null;
}
```

Same shape and computation as [`StatsSummary`](#statssummary) -- see there for how
`avgDurationMs` is averaged and how deleted-job history is excluded from live aggregates.
`DashboardData.runs` likewise lists only runs whose parent job still exists, even though deleted
job runs remain directly queryable by run id.

### DashboardJob

```ts
interface DashboardJob {
  id: string;
  description: string | null;
  enabled: boolean;
  scheduleLabel: string;
  actionKind: 'script' | 'exec' | 'prompt';
  lastStatus: string | null;
  lastRunAt: number | null;
  nextRunAt: string | null;
  job: Job;
}
```

### DashboardRun

```ts
interface DashboardRun {
  id: string;
  jobId: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  exitCode: number | null;
  error: string | null;
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

### DashboardStartResult

```ts
interface DashboardStartResult extends DashboardStatus {
  startedDaemon: boolean;
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

Fills `action.engine` from config `defaultEngine` if unset on prompt actions.

### normalizeJobInput

```ts
function normalizeJobInput(input: JobCreateInput, options?: NormalizeJobInputOptions): Job;
```

### normalizeJobPatch

```ts
function normalizeJobPatch(id: string, existing: Job, patch: JobPatchInput, options?: NormalizeJobInputOptions): Job;
```

### jobJsonSchema

```ts
function jobJsonSchema(): unknown;
```

Returns the JSON Schema (object) generated from `JobSchema` via `zod-to-json-schema`.

### jobJsonSchemaText

Exported from `src/schema-json.ts`; the JSON Schema as a formatted string.

### Config Functions

```ts
function configFilePath(options?: ConfigOptions): string;
function loadConfig(options?: ConfigOptions): CrontickConfig;
function readConfigFile(options?: ConfigOptions): CrontickConfig | null;
function writeConfigFile(config: unknown, options?: ConfigOptions): CrontickConfig;
function initConfig(options?: InitConfigOptions): { path: string; config: CrontickConfig; created: boolean };
function validateConfigFile(options?: ConfigOptions): ConfigValidationResult;
function getConfigValue(path: string | undefined, options?: ConfigOptions): unknown;
function setConfigValue(path: string, value: unknown, options?: ConfigOptions): CrontickConfig;
function removeConfigValue(path: string, options?: ConfigOptions): CrontickConfig;
function listEngines(options?: ConfigOptions): Record<string, EngineConfig>;
function addEngine(name: string, engine: unknown, options?: ConfigOptions): CrontickConfig;
function updateEngine(name: string, engine: unknown, options?: ConfigOptions): CrontickConfig;
function removeEngine(name: string, options?: ConfigOptions): CrontickConfig;
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

Build-time injected version from `package.json` (currently `"0.1.1"`).

### BUILT_IN_CONFIG

```ts
const BUILT_IN_CONFIG: CrontickConfig;
```

```json
{ "defaultEngine": "copilot", "engines": { "copilot": { "command": "copilot", "args": ["--allow-all-tools", "-p"], "env": {} } }, "retention": { "maxRunsPerJob": 100, "maxOutputBytesPerRun": 2000000, "maxLogFiles": 30 } }
```

### SURFACE_CAPABILITIES

```ts
const SURFACE_CAPABILITIES: readonly SurfaceCapability[];
```

37-element array mapping every capability to its client method, CLI command path, and
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
[storage internals](../internals/storage.md#orphan-reconciliation). Not a thrown `CrontickError`
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

