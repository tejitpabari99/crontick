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
| `createJob` | `(input: Job \| JobCreateInput, options?: NormalizeJobInputOptions): Promise<Job>` | Created `Job` | `CrontickError` (`VALIDATION_ERROR`, `DAEMON_REQUEST_FAILED`) |
| `createJobFromCliOptions` | `(input: JobCreateCliOptions): Promise<Job>` | Created `Job` | `CrontickError` |
| `listJobs` | `(): Promise<Job[]>` | Array of `Job` | `CrontickError` |
| `getJob` | `(id: string): Promise<Job>` | `Job` | `CrontickError` (`NOT_FOUND`) |
| `updateJob` | `(id: string, patch: JobPatchInput, options?: NormalizeJobInputOptions): Promise<Job>` | Updated `Job` | `CrontickError` |
| `deleteJob` | `(id: string): Promise<{ ok: true }>` | `{ ok: true }` | `CrontickError` (`NOT_FOUND`) |
| `enableJob` | `(id: string): Promise<Job>` | Updated `Job` | `CrontickError` |
| `disableJob` | `(id: string): Promise<Job>` | Updated `Job` | `CrontickError` |
| `runNow` | `(id: string): Promise<{ runId: string }>` | `{ runId }` | `CrontickError` |
| `cancelRun` | `(runId: string): Promise<{ ok: true; canceled: boolean }>` | Cancel result | `CrontickError` |
| `getRun` | `(runId: string): Promise<unknown>` | Run object | `CrontickError` |
| `listRuns` | `(options?: { jobId?: string; limit?: number; since?: number }): Promise<unknown[]>` | Array of runs | `CrontickError` |
| `getLogs` | `(runId: string, options?: { lines?: number }): Promise<LogsResult>` | `LogsResult` | `CrontickError` |
| `exportJobs` | `(): Promise<{ jobs: Job[] }>` | Export payload | `CrontickError` |
| `importJobs` | `(jobs: unknown[], options?: NormalizeJobInputOptions): Promise<unknown>` | Import result | `CrontickError` |
| `validateSchedule` | `(schedule: Schedule): Promise<unknown>` | Validation result | `CrontickError` |
| `previewSchedule` | `(input: { schedule: Schedule; n?: number; tz?: string }): Promise<unknown>` | Fire times | `CrontickError` |
| `statsSummary` | `(): Promise<StatsSummary>` | `StatsSummary` | `CrontickError` |
| `statsJob` | `(id: string): Promise<JobStats>` | `JobStats` | `CrontickError` |
| `daemonStart` | `(options?: { foreground?: boolean }): Promise<DaemonStartResult>` | Start result | `CrontickError` |
| `daemonStop` | `(): Promise<DaemonStopResult>` | Stop result | `CrontickError` |
| `daemonRestart` | `(): Promise<DaemonRestartResult>` | Restart result | `CrontickError` |
| `daemonReload` | `(): Promise<{ ok: true }>` | `{ ok: true }` | `CrontickError` |
| `daemonStatus` | `(): Promise<unknown>` | Status object | `CrontickError` |
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

### JobCreateCliOptions

```ts
interface JobCreateCliOptions {
  id: string;
  engineArgs?: string[];
  rawArgs?: string[];
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
}
```

### JobPatchCliOptions

```ts
type JobPatchCliOptions = Omit<JobCreateCliOptions, 'id'>;
```

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

Replaces known secret patterns (Bearer tokens, AWS keys, GitHub PATs, `KEY=VALUE` env leaks) with `[REDACTED]`.

### redactValue

```ts
function redactValue(value: unknown, keyHint?: string): unknown;
```

Recursively redacts secrets from objects. Keys matching `/token|secret|password|credential|apikey|api_key|authorization|cookie/i` are fully replaced.

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
{ "defaultEngine": "copilot", "engines": { "copilot": { "command": "copilot", "args": [], "env": {} } } }
```

### SURFACE_CAPABILITIES

```ts
const SURFACE_CAPABILITIES: readonly SurfaceCapability[];
```

36-element array mapping every capability to its client method, CLI command path, and MCP tool name.

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
