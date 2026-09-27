# Configuration Reference

All configuration inputs for crontick: the config file, environment variables, and data directory layout.

---

## Config File

**Location:** `<dataDir>/config.json`

The data directory is resolved by (in order):

1. `CRONTICK_HOME` environment variable (if set)
2. `env-paths('crontick', { suffix: '' }).data` (platform default)

`crontick info` prints the resolved config path (`configPath`) and daemon state. There are no config get/set/unset/init/validate or engine-management CLI/MCP commands; edit `config.json` by hand. If the file does not exist, crontick uses the built-in default config.

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
      "args": ["<arg>", "..."],
      "env": { "<KEY>": "<VALUE>" }
    }
  },
  "retention": {
    "maxRunsPerJob": 100,
    "maxOutputBytesPerRun": 2000000,
    "maxLogFiles": 30
  },
  "logging": {
    "fileEnabled": true,
    "dir": "<optional-override-dir>"
  }
}
```

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `defaultEngine` | `string` | no | `"copilot"` | Must match a key in `engines`; regex `^[A-Za-z0-9_.-]+$` |
| `engines` | `Record<string, EngineConfig>` | no | built-in `copilot` engine | At least one engine must be defined |
| `retention` | `RetentionConfig` | no | `{ maxRunsPerJob: 100, maxOutputBytesPerRun: 2000000, maxLogFiles: 30 }` | See below |
| `logging` | `LoggingConfig` | no | `{ fileEnabled: true }` | See below |

### Built-in Default (no file needed)

```json
{
  "defaultEngine": "copilot",
  "engines": {
    "copilot": { "command": "copilot", "args": ["--allow-all-tools", "-p"], "env": {} }
  },
  "retention": {
    "maxRunsPerJob": 100,
    "maxOutputBytesPerRun": 2000000,
    "maxLogFiles": 30
  },
  "logging": {
    "fileEnabled": true
  }
}
```

The file config is deep-merged over the built-in defaults. `config.json` must be strict JSON; unknown fields are rejected by the schema.

---

## When Config Edits Take Effect

Most config is read fresh for each run and applies automatically on the **next run** without `crontick info daemon reload` or a restart:

- engine definitions under `engines`
- `defaultEngine`
- the resolved prompt command built by `buildPromptRunCommand()`
- logging settings (`logging.fileEnabled`, `logging.dir`)
- per-run output retention (`retention.maxOutputBytesPerRun`)
- daemon log-file retention (`retention.maxLogFiles`) the next time log retention is applied

The exception is `retention.maxRunsPerJob`. The daemon's Store reads and caches that value at daemon startup. Changing `retention.maxRunsPerJob` requires:

```bash
crontick info daemon stop
# then run any daemon-backed command (for example `crontick jobs list`) to start it again
```

`crontick info daemon reload` is for reloading job definitions from disk; it is not required for normal config edits and does not replace the restart requirement for `retention.maxRunsPerJob`.

---

## RetentionConfig

| Field | Type | Required | Default | Constraints | Runtime behavior |
|-------|------|----------|---------|-------------|------------------|
| `maxRunsPerJob` | `integer` | no | `100` | `min(1)`, `max(100_000)` | Cached by Store at daemon startup; changing requires a restart (CLI: `crontick info daemon stop`, then the next daemon-backed command) |
| `maxOutputBytesPerRun` | `integer` | no | `2_000_000` | `min(1024)`, `max(1_000_000_000)` | Re-read per run; applies on the next run |
| `maxLogFiles` | `integer` | no | `30` | `min(1)`, `max(3650)` | Applies the next time daemon log retention runs |

`maxRunsPerJob` retains at most that many runs per job. Oldest terminal runs (not `running`/`queued`) and their crontick-side log rows are evicted best-effort.

`maxOutputBytesPerRun` bounds a single run's captured stdout/stderr. Once hit, further output is dropped at a UTF-8 character boundary, a truncation marker is appended, and the run's `outputTruncated` field is set.

`maxLogFiles` bounds daily `daemon-YYYY-MM-DD.log` files under the daemon log directory; oldest files beyond the cap are deleted best-effort.

See [state-and-storage.md](../concepts/state-and-storage.md#run-history-retention) for the user-facing model, and [storage internals](../internals/storage.md) for eviction details.

---

## LoggingConfig

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `fileEnabled` | `boolean` | no | `true` | — |
| `dir` | `string` | no | `<dataDir>/logs` | Non-empty when set |

Every run's logs are stored in SQLite and can be read with `crontick runs logs`. When file logging is enabled, the same engine and crontick lifecycle streams are mirrored to `<dir>/<jobId>.log`. File logging is best-effort and never blocks or fails a run. Logging config is read per run, so edits apply automatically to new runs.

---

## EngineConfig

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `command` | `string` | yes | — | Min length 1 |
| `args` | `string[]` | no | `[]` | — |
| `env` | `Record<string, string>` | no | `{}` | — |

Schema is `.strict()` — no extra fields allowed.

### Prompt-engine argv ordering

`buildPromptRunCommand()` emits prompt-engine argv as:

```text
[..., ...engine.args, prompt, ...action.args]
```

If an engine requires an explicit prompt-taking flag for non-interactive use, that flag must be the final entry in `engine.args` so the appended prompt text becomes its value. For the built-in Copilot engine, the default is `['--allow-all-tools', '-p']`, producing:

```text
copilot --allow-all-tools -p <prompt>
```

### Multi-engine example

```json
{
  "defaultEngine": "copilot",
  "engines": {
    "copilot": {
      "command": "copilot",
      "args": ["--allow-all-tools", "-p"],
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

Custom engines are configurable entries. Only `command` must be on `PATH`.

---

## Script and Exec Actions

Script and exec action kinds remain fully supported in the job schema, daemon executors, and core client. Their dedicated CLI flags and MCP convenience parameters were removed to keep the shims focused on the common prompt workflow. To create script or exec jobs:

- use a full job-definition JSON file with `crontick jobs new --file <job.json>`; or
- call `client.createJob()` from the library with `action.kind: "script"` or `action.kind: "exec"`.

---

## Environment Variables

| Variable | Type | Default | Effect |
|----------|------|---------|--------|
| `CRONTICK_HOME` | string (path) | Platform via `env-paths` | Overrides the data directory root |
| `CRONTICK_DAEMON_URL` | string (URL) | Port file discovery | Explicit daemon base URL (for example, `http://127.0.0.1:9876`) |
| `CRONTICK_DAEMON_BINARY` | string (path) | Resolved from built files | Override path to daemon script |
| `CRONTICK_MCP_START_DAEMON` | `"0"` to disable | Enabled (any other value) | When `"0"`, MCP server does not demand-start the daemon |
| `CRONTICK_VERBOSE` | string | Disabled | `1\|true\|yes\|on\|debug` enables verbose logging |
| `CRONTICK_PLUGIN_NONINTERACTIVE` | any | — | Skips interactive prompts in plugin installer |
| `CRONTICK_PLUGIN_SKIP_NPM` | any | — | Skips npm install in plugin installer |

### Precedence

For daemon URL resolution:

1. `CrontickClientOptions.daemonUrl`
2. `CRONTICK_DAEMON_URL`
3. Port file at `<dataDir>/daemon.port`

For verbose mode:

1. `CrontickClientOptions.verbose` or CLI `--verbose`
2. `CRONTICK_VERBOSE`

For data directory:

1. `CRONTICK_HOME`
2. `env-paths('crontick', { suffix: '' }).data`

---

## State Directory Layout

Root: `CRONTICK_HOME` or platform default.

```text
<dataDir>/
├── config.json                 Config file (engines, defaultEngine, retention, logging)
├── jobs/                       Per-job JSON files (source of truth)
│   ├── <job-id>.json           Job definition
│   └── <job-id>.schema.json    JSON Schema sidecar
├── runs.db                     SQLite (WAL mode): runs, run_logs, jobs cache
├── logs/
│   ├── daemon-YYYY-MM-DD.log   Daemon runtime logs (JSON lines)
│   ├── daemon.ensure.log       Demand-start output capture
│   └── <job-id>.log            Per-job full log (engine output + crontick lifecycle events)
├── daemon.pid                  PID of running daemon process
├── daemon.port                 Port of daemon HTTP API
└── daemon.ensure.lock          Exclusive startup lock file
```

### Resolved Data Directory Paths by OS

| OS | Default Path |
|----|-------------|
| Windows | `%LOCALAPPDATA%\crontick` |
| macOS | `~/Library/Application Support/crontick` |
| Linux | `$XDG_DATA_HOME/crontick` (typically `~/.local/share/crontick`) |

---

## SQLite Schema (runs.db)

Journal mode: WAL. The full schema is documented in [internals/storage.md](../internals/storage.md#schema).

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
