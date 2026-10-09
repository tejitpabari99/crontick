# Configuration Reference

All configuration inputs for crontick: the config file, environment variables, and data directory layout.

---

## Config File

**Location:** `<dataDir>/config.json`

The data directory is resolved by (in order):

1. `CRONTICK_HOME` environment variable (if set)
2. `env-paths('crontick', { suffix: '' }).data` (platform default)

`crontick info` prints the resolved config path (`configPath`) and daemon state. Edit the file with `crontick config list|get|set|unset` (see [Editing config](#editing-config)), the dashboard Settings modal, or by hand. The daemon (and the first daemon-backed command) creates the file automatically with the full explicit built-in config (`defaultEngine`, `engines.claude`, `retention`, `logging.fileEnabled`, `defaults.overlap/retry`; `timeoutSec` is omitted because it is unset), mode 0600, using an exclusive create so an existing file is never touched. `crontick info` stays read-only and reports `not created yet` until then. Trade-off: because the file lists every default explicitly, a default that changes in a later crontick version does not reach users who already have the file; delete a key (or the file) to follow the new built-in default.

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
      "env": { "<KEY>": "<VALUE>" },
      "type": "raw"
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
  },
  "maxConsecutiveFailures": 3,
  "defaults": {
    "overlap": "skip",
    "timeoutSec": 3600,
    "retry": { "max": 0, "backoffSec": 30 }
  }
}
```

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `defaultEngine` | `string` | no | `"claude"` | Must match a key in `engines`; regex `^[A-Za-z0-9_.-]+$` |
| `engines` | `Record<string, EngineConfig>` | no | built-in `claude` engine | At least one engine must be defined |
| `retention` | `RetentionConfig` | no | `{ maxRunsPerJob: 100, maxOutputBytesPerRun: 2000000, maxLogFiles: 30 }` | See below |
| `logging` | `LoggingConfig` | no | `{ fileEnabled: true }` | See below |
| `maxConsecutiveFailures` | `integer` | no | `3` | Positive integer; a job is auto-disabled after this many consecutive `failed`/`timeout` runs. Read when each run finishes; applies without a reload |
| `defaults` | `JobDefaultsConfig` | no | `{ overlap: "skip", retry: { max: 0, backoffSec: 30 } }` | See below; `timeoutSec` is unset by default |

### Built-in Default (no file needed)

```json
{
  "defaultEngine": "claude",
  "engines": {
    "claude": { "command": "claude", "args": [], "env": {}, "type": "claude" }
  },
  "retention": {
    "maxRunsPerJob": 100,
    "maxOutputBytesPerRun": 2000000,
    "maxLogFiles": 30
  },
  "logging": {
    "fileEnabled": true
  },
  "maxConsecutiveFailures": 3,
  "defaults": {
    "overlap": "skip",
    "retry": { "max": 0, "backoffSec": 30 }
  }
}
```

The file config is deep-merged over the built-in defaults. `config.json` must be strict JSON; unknown fields are rejected by the schema.

### Job defaults

| Field | Type | Built-in default | Constraints |
|-------|------|------------------|-------------|
| `defaults.overlap` | `"skip" \| "queue" \| "cancel-previous"` | `"skip"` | Valid overlap policy |
| `defaults.timeoutSec` | `number` | unset (no timeout) | Positive when set |
| `defaults.retry.max` | `integer` | `0` | At least 0 |
| `defaults.retry.backoffSec` | `number` | `30` | Positive |

On creation, each omitted job field takes its value from `config.json` `defaults`, then the built-in fallback. A CLI flag takes precedence over a value in a job JSON file, and explicit job values take precedence over config defaults. The resolved overlap, retry, and optional action timeout are saved in the job definition. Editing `defaults` affects subsequently created jobs; an update that omits these fields keeps the existing job values.

---

## Editing config

`crontick config list|get|set|unset` (CLI), `crontick_config_*` (MCP), `configList/configGet/configSet/configUnset` (library) and `GET`/`PATCH /api/config` (dashboard Settings) share one write core, so validation and behavior are identical. Normative contract: [specs/008-config-editing.md](../specs/008-config-editing.md). Design rationale: [ADR 0004](../decisions/0004-config-writes-file-direct-and-pause.md).

- **File-direct.** CLI, MCP and library write `config.json` directly. They work with the daemon down or broken and never demand-start it. Afterwards a running daemon is reloaded best-effort (`reload`: `reloaded`, `daemon-not-running` or `failed`; a failed reload never fails the save, run `crontick daemon reload`). The dashboard goes through the daemon API.
- **Atomic and sparse.** The change is validated against the full schema first; on any error nothing is written. Only the keys you set are stored, so untouched defaults are never baked into the file. A file that is already invalid or unparsable is refused: fix it by hand.
- **Keys.** Dotted paths per the schema (`defaults.timeoutSec`, `engines.claude.command`). Engines are added or replaced with `set engines.<name> '<json object>'` and removed with `unset engines.<name>`; removing `defaultEngine`'s engine or the last engine is rejected. A key inside a map that itself contains `.` (an env var named `A.B`) cannot be addressed by dotted path: set the parent `env` object.
- **`daemon.*` is read-only while a daemon runs.** `set`/`unset` of `daemon` or anything under it fails with `CONFIG_KEY_READ_ONLY` if a daemon process is up (stop it first: `crontick daemon stop`, then `crontick config set daemon.port <n>`). The API and dashboard always treat it as read-only. `config get daemon.port` always works.
- **Secrets.** Every read redacts secret-like values (`env` values, secret-looking args) as `[REDACTED]`. A write that echoes a redacted value back at the same path keeps the stored secret; any other string containing `[REDACTED]` is rejected (`CONFIG_REDACTED_VALUE`); typing a real value replaces the secret.
- **Concurrency.** Writes take `config.json.lock` (retry up to 2 s, a lock older than 10 s is broken, else `CONFIG_LOCKED`), re-read, apply, then rename a temp file over the config (retried on Windows `EPERM`/`EBUSY`). An existing file keeps its mode; a new file is 0600. `GET /api/config` and `configList` return a `revision` (sha256 of the file bytes, or `absent`); pass it back as `ifRevision` and a changed file fails with `CONFIG_CONFLICT` (HTTP 409).
- **In-flight runs.** If the daemon is up and runs are executing or queued, a save fails with `RUNS_IN_FLIGHT` (HTTP 409, lists the runs) unless you choose: `--stop-running` / `inFlight: 'stop'` cancels them (status `canceled`, no retry, no `--after` dependents, queued runs dropped) then applies; `--wait-running` / `inFlight: 'wait'` pauses the daemon, waits with no timeout for all runs to finish, applies, then resumes. On a TTY the CLI prompts. The wait is held in the daemon; if the daemon restarts during it, the pending apply is lost and reported as `lostPendingConfigApply` in `daemon status`. See [Daemon pause](../concepts/daemon-lifecycle.md#pause-and-resume).
- **Notice.** Every successful write returns: "Saved. Running runs are not affected. Default changes apply to new jobs only. Engine changes apply on the next run. `daemon.port` needs a restart." (CLI prints it on stderr, the dashboard shows a toast.)
- **Unknown keys** are rejected (strict schema), including in hand-edited files: one typo makes the file invalid until fixed.

---

## When Config Edits Take Effect

Most config is read fresh for each run and applies automatically on the **next run** without `crontick daemon reload` or a restart:

- engine definitions under `engines`
- the resolved prompt command built by `buildPromptRunCommand()`
- logging settings (`logging.fileEnabled`, `logging.dir`)
- per-run output retention (`retention.maxOutputBytesPerRun`)
- the auto-disable threshold (`maxConsecutiveFailures`), read when each run finishes
- daemon log-file retention (`retention.maxLogFiles`) the next time log retention is applied

`defaultEngine` and `defaults.overlap`, `defaults.timeoutSec`, and
`defaults.retry` are read when a job is created. Existing jobs keep the
engine and default values saved in their job files after a config edit.

The exception is `retention.maxRunsPerJob`. The daemon's Store caches that value, reading it at daemon startup and again on `crontick daemon reload`. `crontick config set|unset` (and the dashboard) reload a running daemon for you after saving. After a hand edit, run:

```bash
crontick daemon reload
```

(or restart the daemon). A reload also re-applies `retention.maxLogFiles` immediately. A reload is otherwise for reloading job definitions from disk and is not required for other config edits. A malformed or out-of-range config makes the reload fail and leaves the previous schedule intact.

---

## DaemonConfig

| Field | Type | Required | Default | Constraints | Runtime behavior |
|-------|------|----------|---------|-------------|------------------|
| `port` | `integer` | no | unset (prefers `47615`) | `min(0)`, `max(65535)` | Read at daemon startup. Unset: prefer `47615`, falling back to a free port when taken. Set: bind exactly that port; `0` picks a free port. The bound port is recorded in `<dataDir>/daemon.port` |

`daemon.port` is read only at daemon startup. Editing it has no effect until `crontick daemon restart` (a `daemon reload` never rebinds); while the running port differs from the configured one, `daemon status`, `info` and `doctor` note `config says daemon.port N, running on M`. If an explicit port is already in use the daemon exits with `DAEMON_PORT_IN_USE` (see [errors.md](errors.md#daemon_port_in_use)) instead of falling back. `0` is valid and always OS-assigned. The former daemon-port environment variable override was removed and is no longer read.

## RetentionConfig

| Field | Type | Required | Default | Constraints | Runtime behavior |
|-------|------|----------|---------|-------------|------------------|
| `maxRunsPerJob` | `integer` | no | `100` | `min(1)`, `max(100_000)` | Cached by Store at daemon startup and re-read on `crontick daemon reload`; changing it needs a reload or restart |
| `maxOutputBytesPerRun` | `integer` | no | `2_000_000` | `min(1024)`, `max(1_000_000_000)` | Re-read per run; applies on the next run |
| `maxLogFiles` | `integer` | no | `30` | `min(1)`, `max(3650)` | Applies the next time daemon log retention runs |

`maxRunsPerJob` retains at most that many runs per job. Oldest terminal runs (not `running`/`queued`) and their stored output are evicted best-effort.

`maxOutputBytesPerRun` bounds the plain stdout captured from an engine without structured-stream support (raw/text engines); Claude stream-json runs keep only the final result event and are not bounded by it. It does not cap stderr: stderr has its own fixed cap of 1,000,000 bytes per run (`DEFAULT_MAX_STDERR_BYTES_PER_RUN`, not configurable). When either cap is hit, further output is dropped at a UTF-8 character boundary, a truncation marker is appended, and the run's `outputTruncated` field is set.

`maxLogFiles` bounds daily `daemon-YYYY-MM-DD.log` files under the daemon log directory; oldest files beyond the cap are deleted best-effort.

See [state-and-storage.md](../concepts/state-and-storage.md#run-history-retention) for the user-facing model, and [storage internals](../implementation/storage.md) for eviction details.

---

## LoggingConfig

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `fileEnabled` | `boolean` | no | `true` | — |
| `dir` | `string` | no | `<dataDir>/logs` | Non-empty when set |

crontick stores only its own logs: when file logging is enabled, crontick-side lifecycle events (run started, executing, retries, session capture, run finished) are written to a single per-job file `<dir>/<jobId>.log` (appended across all runs of the job, each line prefixed with a timestamp and the run id; `crontick runs get` prints its path and `getRun` exposes it as `logFile`). The engine's raw stdout/stderr is never written to the database or this file; the runner keeps its own transcript. The cleaned output shown by `crontick runs get` is stored with the run. Deleting the job deletes this file. File logging is best-effort and never blocks or fails a run. Logging config is read per run, so edits apply automatically to new runs.

---

## EngineConfig

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `command` | `string` | yes | — | Min length 1 |
| `args` | `string[]` | no | `[]` | — |
| `env` | `Record<string, string>` | no | `{}` | — |
| `type` | `"raw" \| "claude"` | no | `"raw"` | Selects the engine adapter; omitted custom engines resolve to `raw` |

Schema is `.strict()` — no extra fields allowed.

### Prompt-engine argv ordering

`buildPromptRunCommand()` dispatches by engine `type`. A custom engine with
an omitted `type` uses the `raw` adapter, which emits:

```text
[...engine.args, prompt, ...action.args, --session-id=<id>?]
```

If a raw engine requires an explicit prompt-taking flag, put it last in
`engine.args` so the appended prompt becomes its value. The built-in Claude
adapter instead produces:

```text
claude -p <prompt> --output-format stream-json --verbose --session-id <uuid> ...action.args --settings <json>
```

### Multi-engine example

```json
{
  "defaultEngine": "claude",
  "engines": {
    "claude": {
      "command": "claude",
      "args": [],
      "env": {},
      "type": "claude"
    },
    "agency": {
      "command": "agency",
      "args": ["cp", "--logs-dir=Q:\\Repos\\crontick\\.crontick\\agency-logs"],
      "env": {},
      "type": "raw"
    }
  }
}
```

Custom engines are configurable entries. Their commands must be installed and
available on `PATH`. Claude requires the Claude Code CLI. Crontick does not add
permission flags by default; use job `action.args` (or CLI passthrough) to opt
into a permission mode or to set `--max-budget-usd`.

---

## Environment Variables

| Variable | Type | Default | Effect |
|----------|------|---------|--------|
| `CRONTICK_HOME` | string (path) | Platform via `env-paths` | Overrides the data directory root |
| `CRONTICK_DAEMON_URL` | string (URL) | Port file discovery | Explicit daemon base URL (for example, `http://127.0.0.1:9876`) |
| `CRONTICK_DAEMON_BINARY` | string (path) | Resolved from built files | Override path to daemon script |
| `CRONTICK_MCP_START_DAEMON` | `"0"` to disable | Enabled (any other value) | When `"0"`, MCP server does not demand-start the daemon |
| `CRONTICK_VERBOSE` | string | Disabled | `1\|true\|yes\|on\|debug` enables verbose logging |
| `CLAUDE_CONFIG_DIR` | string (path) | `~` | Read by the Claude trust check: crontick looks for `.claude.json` here (else `~/.claude.json`) |

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
├── config.json                 Config file (engines, defaultEngine, defaults, retention, logging)
├── jobs/                       Per-job JSON files (source of truth)
│   ├── <job-id>.json           Job definition
│   └── <job-id>.schema.json    JSON Schema sidecar
├── runs.db                     SQLite (WAL mode): runs, run_outputs, jobs cache
├── logs/
│   ├── daemon-YYYY-MM-DD.log   Daemon runtime logs (JSON lines)
│   ├── daemon.ensure.log       Demand-start output capture
│   └── <job-id>.log            Per-job log (crontick lifecycle events only)
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

Journal mode: WAL. The full schema is documented in [implementation/storage.md](../implementation/storage.md#schema).

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
