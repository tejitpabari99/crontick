# Core Client

Implements: `src/client.ts`

The `CrontickClient` class is the single programmatic entry point for all
crontick operations. CLI, MCP, and library consumers instantiate it and call its
methods; the class handles daemon discovery, auto-start, HTTP transport, and
error translation.

---

## Constructor Options

Defined as `CrontickClientOptions` in `src/client.ts`:

| Option | Type | Default | Purpose |
|--------|------|---------|---------|
| `daemonUrl` | `string` | - | Explicit daemon base URL; skips port-file discovery |
| `daemonScript` | `string` | - | Path to daemon entry JS for demand-start |
| `startDaemon` | `boolean` | `true` | Allow auto-starting the daemon on first request |
| `startupTimeoutMs` | `number` | 10000 | Max time to wait for daemon to become healthy |
| `healthTimeoutMs` | `number` | 2000 | Timeout for individual health probes |
| `lockTimeoutMs` | `number` | 15000 | Timeout waiting for daemon start lock |
| `requestTimeoutMs` | `number` | 30000 | Per-HTTP-request timeout (AbortSignal.timeout) |
| `cwd` | `string` | - | Working directory for job normalization |
| `mcpScript` | `string` | - | MCP binary path (passed to doctor checks) |
| `verbose` | `boolean` | false | Enable debug logging; also reads `CRONTICK_VERBOSE` |
| `onLog` | `LogSink` | - | Callback receiving structured log events |
| `logger` | `Logger` | - | Fully custom logger instance |
| `env` | `NodeJS.ProcessEnv` | - | Override environment for path/env resolution |

---

## Public Methods

Every public method delegates to one of two paths:

1. **HTTP request to daemon** -- most operations (jobs, runs, stats, daemon control).
2. **Local-only** -- config, doctor, `jobJsonSchema()`, `drainNotices()`, `isVerbose()`.

HTTP methods call `this.request(method, path, body?, options?)` which handles
ensure, retry, and error wrapping.

### Key method signatures (abridged)

```ts
async ensure(): Promise<DaemonInfo>
async createJob(input: Job | JobCreateInput, options?): Promise<Job>
async listJobs(): Promise<Job[]>
async getJob(id: string): Promise<Job>
async updateJob(id: string, patch: JobPatchInput, options?): Promise<Job>
async deleteJob(id: string): Promise<{ ok: true }>
async enableJob(id: string): Promise<Job>
async disableJob(id: string): Promise<Job>
async runNow(id: string): Promise<{ runId: string }>
async cancelRun(runId: string): Promise<{ ok: true; canceled: boolean }>
async listRuns(options?: { jobId?; limit?; since? }): Promise<unknown[]>
async getLogs(runId: string, options?: { lines? }): Promise<LogsResult>
async statsSummary(): Promise<StatsSummary>
async daemonStart(options?: { foreground? }): Promise<DaemonStartResult>
async daemonStop(): Promise<DaemonStopResult>
async daemonRestart(): Promise<DaemonRestartResult>
async daemonReload(): Promise<{ ok: true }>
```

---

## HTTP Transport

`request<T>(method, path, body?, options?)` in `src/client.ts` line 331:

1. Resolves `baseUrl` -- calls `ensure()` when `options.ensure` is true (default).
2. Sends `fetch()` with JSON body and `AbortSignal.timeout(requestTimeoutMs)`.
3. On network error with auto-start allowed: clears cached URL, re-ensures daemon,
   waits 100 ms (`boundedBackoff`), retries once.
4. Parses JSON response. Non-2xx responses are translated to `CrontickError` using
   the `error.code` / `error.message` fields from the daemon response body.

---

## Auto-Start Logic

The `ensure()` method delegates to `ensureDaemon()` in `src/daemon/ensure.ts`.
The decision tree:

1. Explicit `daemonUrl` or `CRONTICK_DAEMON_URL` set -> probe health; throw if unreachable.
2. Read port file (`<dataDir>/daemon.port`) -> probe health at that port.
3. If healthy, return existing info with `started: false`.
4. If `startDaemon` is false, throw `DAEMON_NOT_RUNNING`.
5. Acquire exclusive file lock (`daemon.ensure.lock`, mode `'wx'`).
6. Spawn daemon detached with stdout/stderr to `daemon.ensure.log`.
7. Poll port file + health every 100 ms until `startupTimeoutMs`.
8. Release lock on success or failure.

---

## Error Translation

All daemon HTTP errors are normalized to `CrontickError` (from `src/errors.ts`):

- Network failures -> `DAEMON_REQUEST_FAILED`
- Non-JSON responses -> `PARSE_ERROR`
- Daemon 4xx/5xx -> code from response body `error.code`, or `API_ERROR`

The `CrontickError` class carries `code: string`, `message: string`, and
optional `details: unknown`.

---

## Notices

`normalizeJobInput()` may emit notices (e.g., prompt-file read). These are
collected via `this.notices` and drained with `drainNotices()` so CLI/MCP can
display them after the operation succeeds.
