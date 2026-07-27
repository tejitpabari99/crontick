# Configuration Reference

All configuration inputs for crontick: file, environment variables, and data directory layout.

---

## Config File

**Location:** `<dataDir>/config.json`

The data directory is resolved by (in order):
1. `CRONTICK_HOME` environment variable (if set)
2. `env-paths('crontick', { suffix: '' }).data` (platform default)

### Resolved Config File Paths by OS

| OS | Default Path |
|----|-------------|
| Windows | `%LOCALAPPDATA%\crontick\config.json` |
| macOS | `~/Library/Application Support/crontick/config.json` |
| Linux | `$XDG_DATA_HOME/crontick/config.json` (typically `~/.local/share/crontick/config.json`) |

### Schema

```json
{
  "defaultEngine": "<engine-name>",
  "engines": {
    "<name>": {
      "command": "<executable>",
      "args": ["<arg>", ...],
      "env": { "<KEY>": "<VALUE>", ... }
    }
  },
  "retention": {
    "maxRunsPerJob": 100,
    "maxOutputBytesPerRun": 2000000,
    "maxLogFiles": 30
  }
}
```

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `defaultEngine` | `string` | no | `"copilot"` | Must match a key in `engines`; regex `^[A-Za-z0-9_.-]+$` |
| `engines` | `Record<string, EngineConfig>` | no | `{ copilot: { command: "copilot", args: [], env: {} } }` | At least one engine must be defined |
| `retention` | `RetentionConfig` | no | `{ maxRunsPerJob: 100, maxOutputBytesPerRun: 2000000, maxLogFiles: 30 }` | See below |

### RetentionConfig

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `maxRunsPerJob` | `integer` | no | `100` | `min(1)`, `max(100_000)` |
| `maxOutputBytesPerRun` | `integer` | no | `2_000_000` | `min(1024)`, `max(1_000_000_000)` |
| `maxLogFiles` | `integer` | no | `30` | `min(1)`, `max(3650)` |

Each job retains at most `maxRunsPerJob` runs; the oldest terminal runs (not `running`/`queued`)
are evicted first, along with their logs, whenever a new run is inserted, and again in a startup
pass (`pruneAllJobsRunHistory()`) that catches a job whose cap was just lowered via `crontick
daemon reload` but that hasn't ticked since. Eviction is best-effort: a failure is logged but
never fails a run insert or blocks daemon startup. Changing `retention.maxRunsPerJob` and running
`crontick daemon reload` applies the new cap immediately, without a daemon restart.

`maxOutputBytesPerRun` bounds a single run's captured stdout/stderr; once hit, further output is
dropped at a UTF-8 character boundary (a multi-byte character is never split), a truncation
marker is appended, and the run's `outputTruncated` field is set. This cap is also re-read on
`crontick daemon reload`.

`maxLogFiles` bounds how many daily `daemon-YYYY-MM-DD.log` files are kept under the daemon's log
directory; the oldest files beyond the cap are deleted, keeping the newest. Applied at daemon
startup and again on `crontick daemon reload` (a lowered value takes effect immediately, without
a restart). Pruning is best-effort: a failure is logged but never blocks startup or reload.

`RetentionConfigSchema` is `.strict()` — no extra fields allowed. See
[state-and-storage.md](../concepts/state-and-storage.md#run-history-retention) for the
user-facing model, and [storage internals](../internals/storage.md) for the eviction and output-cap algorithms.

### EngineConfig

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `command` | `string` | yes | — | Min length 1 |
| `args` | `string[]` | no | `[]` | — |
| `env` | `Record<string, string>` | no | `{}` | — |

Schema is `.strict()` — no extra fields allowed.

### Built-in Default (no file needed)

```json
{
  "defaultEngine": "copilot",
  "engines": {
    "copilot": { "command": "copilot", "args": [], "env": {} }
  },
  "retention": {
    "maxRunsPerJob": 100,
    "maxOutputBytesPerRun": 2000000,
    "maxLogFiles": 30
  }
}
```

If `config.json` does not exist, crontick uses this built-in config. The file config is deep-merged over the built-in defaults.

### Set vs. Inherited Values

`config get` (with or without a key path) always shows **effective** values — the file
deep-merged over the built-in defaults above. `config unset <path>` removes the key from
`config.json` itself; it does not write the built-in default back into the file. So after
`config unset defaultEngine`, `config get defaultEngine` still reports `"copilot"` (the
inherited built-in default), but the file no longer pins that value explicitly — a future
built-in default change, or restoring `config.json` from an older version, no longer requires
touching that key. To see exactly what's explicitly set (as opposed to inherited), read
`config.json` directly: any key absent from the file is inherited from the built-in default.

### Multi-Engine Example

```json
{
  "defaultEngine": "copilot",
  "engines": {
    "copilot": {
      "command": "copilot",
      "args": ["-p"],
      "env": {}
    },
    "agency": {
      "command": "agency",
      "args": ["cp", "--logs-dir=Q:\\Repos\\crontick\\.crontick\\agency-logs"],
      "env": {}
    }
  }
}
```

Custom engines (like `agency` above) are just configurable entries; only the `command` must be on PATH.

### Config Key Path

Key paths for `config get/set/unset` are dot-separated: `defaultEngine`, `engines.copilot.command`, etc. Keys must match `^[A-Za-z0-9_.-]+$`.

---

## Environment Variables

| Variable | Type | Default | Effect |
|----------|------|---------|--------|
| `CRONTICK_HOME` | string (path) | Platform via `env-paths` | Overrides the data directory root |
| `CRONTICK_DAEMON_URL` | string (URL) | Port file discovery | Explicit daemon base URL (e.g. `http://127.0.0.1:9876`) |
| `CRONTICK_DAEMON_BINARY` | string (path) | Resolved from built files | Override path to daemon script |
| `CRONTICK_MCP_START_DAEMON` | `"0"` to disable | Enabled (any other value) | When `"0"`, MCP server does not demand-start the daemon |
| `CRONTICK_VERBOSE` | string | Disabled | `1\|true\|yes\|on\|debug` (case-insensitive) enables verbose logging |
| `CRONTICK_PLUGIN_NONINTERACTIVE` | any | — | Skips interactive prompts in plugin installer |
| `CRONTICK_PLUGIN_SKIP_NPM` | any | — | Skips npm install in plugin installer |

### Precedence

For daemon URL resolution:
1. `CrontickClientOptions.daemonUrl` (programmatic)
2. `CRONTICK_DAEMON_URL` environment variable
3. Port file at `<dataDir>/daemon.port`

For verbose mode:
1. `CrontickClientOptions.verbose` or CLI `--verbose` flag
2. `CRONTICK_VERBOSE` environment variable

For data directory:
1. `CRONTICK_HOME` environment variable
2. `env-paths('crontick', { suffix: '' }).data`

---

## State Directory Layout

Root: `CRONTICK_HOME` or platform default (see above).

```
<dataDir>/
├── config.json              Config file (engines, defaultEngine)
├── jobs/                    Per-job JSON files (source of truth)
│   ├── <job-id>.json        Job definition
│   └── <job-id>.schema.json JSON Schema sidecar
├── runs.db                  SQLite (WAL mode): runs, run_logs, jobs cache
├── logs/
│   ├── daemon-YYYY-MM-DD.log   Daemon runtime logs (JSON lines)
│   └── daemon.ensure.log       Demand-start output capture
├── daemon.pid               PID of running daemon process
├── daemon.port              Port of daemon HTTP API
└── daemon.ensure.lock       Exclusive startup lock file
```

### Resolved Data Directory Paths by OS

| OS | Default Path |
|----|-------------|
| Windows | `%LOCALAPPDATA%\crontick` |
| macOS | `~/Library/Application Support/crontick` |
| Linux | `$XDG_DATA_HOME/crontick` (typically `~/.local/share/crontick`) |

---

## SQLite Schema (runs.db)

Journal mode: WAL (Write-Ahead Logging). Single-writer (daemon process). The full schema
(`jobs`, `runs`, `run_logs`, `job_schedule_state`, and their indexes) is authoritatively
documented once, alongside the eviction, missed-fire, and orphan-reconciliation algorithms that
operate on it, in [internals/storage.md](../internals/storage.md#schema) -- see that page rather
than duplicating the `CREATE TABLE` statements here.

---

## Path Helper Functions (src/paths.ts)

All accept an optional `env: NodeJS.ProcessEnv` parameter.

| Function | Returns |
|----------|---------|
| `dataDir(env?)` | Root data directory |
| `jobsDir(env?)` | `<dataDir>/jobs` |
| `runsDbPath(env?)` | `<dataDir>/runs.db` |
| `logsDir(env?)` | `<dataDir>/logs` |
| `configPath(env?)` | `<dataDir>/config.json` |
| `pidFilePath(env?)` | `<dataDir>/daemon.pid` |
| `portFilePath(env?)` | `<dataDir>/daemon.port` |
| `ensureDirs(env?)` | Creates `dataDir`, `jobsDir`, `logsDir` if missing |
