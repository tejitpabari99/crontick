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
  }
}
```

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `defaultEngine` | `string` | no | `"copilot"` | Must match a key in `engines`; regex `^[A-Za-z0-9_.-]+$` |
| `engines` | `Record<string, EngineConfig>` | no | `{ copilot: { command: "copilot", args: [], env: {} } }` | At least one engine must be defined |

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
  }
}
```

If `config.json` does not exist, crontick uses this built-in config. The file config is deep-merged over the built-in defaults.

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

Journal mode: WAL (Write-Ahead Logging). Single-writer (daemon process).

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL,
  exit_code INTEGER,
  error TEXT,
  duration_ms INTEGER
);

CREATE TABLE run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  ts INTEGER NOT NULL,
  chunk BLOB NOT NULL
);

CREATE TABLE migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL
);
```

Indexes: `idx_runs_job_id`, `idx_runs_started_at`, `idx_run_logs_run_id`.

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
