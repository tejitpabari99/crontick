# Logging and verbose diagnostics design

## Goals

- One small core-owned logging mechanism shared by client, daemon, CLI, and MCP.
- Core emits structured events only; shims decide where/how to render.
- Verbose diagnostics explain crontick behavior, not invoked agent/model output.
- `--json` stdout stays machine-parseable even when verbose is enabled.
- Secrets, tokens, and sensitive env-shaped values are redacted before emission.

## Core API

`src\logger.ts` owns:

```ts
type LogLevel = "error" | "warn" | "info" | "debug";
interface LogEvent {
  ts: string;
  level: LogLevel;
  component?: string;
  message: string;
  data?: unknown;
}
type LogSink = (event: LogEvent) => void;
interface LoggerOptions { verbose?: boolean; level?: LogLevel; sink?: LogSink }
```

`createLogger(options)` returns a dependency-free logger with
`error/warn/info/debug/child/isDebugEnabled`. Default threshold is `info`;
`verbose: true` raises it to `debug`. `nullLogger` drops all events.

Events are immutable enough for consumers and contain redacted data. Core modules
accept a `Logger`/logger option where diagnostics are useful; they never call
`console.*`, import CLI/MCP SDKs, colourize, or exit the process.

## Event shape and levels

- `error`: failed operation that the shim should surface or persist.
- `warn`: recoverable anomaly, fallback, stale state, skipped malformed input.
- `info`: lifecycle milestones such as daemon start/stop/reload.
- `debug`: verbose-only diagnostics: config paths/keys, state paths, schedule
  choices, resolved commands/argv, spawn/exit, HTTP calls, retries/backoff,
  session-id decisions, daemon connection attempts, and timings.

## Rendering by surface

- CLI builds one logger per invocation. It renders events to stderr as compact
  text (`[crontick:level] component message data-json`). Human command results,
  tables, and JSON stay on stdout.
- MCP builds clients with a buffered logger. Tool responses include a
  `diagnostics` array only when `verbose` is true; stdio protocol stdout is never
  polluted.
- Daemon creates a logger that writes newline-delimited JSON to stderr and to
  `<dataDir>\logs\daemon-YYYY-MM-DD.log`. Startup/ensure logs remain under
  `<dataDir>\logs\daemon.ensure.log`.
- Programmatic users pass `createClient({ verbose: true, onLog })` or a logger.
  Without a sink, events are dropped.

## Verbose propagation

- CLI flag: global `--verbose` / `-v`.
- Environment: `CRONTICK_VERBOSE=1|true|yes|on` enables verbose everywhere.
- Client/API: `CrontickClientOptions.verbose?: boolean`.
- MCP: each tool accepts optional `verbose?: boolean`, and the MCP process also
  honors `CRONTICK_VERBOSE`.
- Daemon: client/CLI/MCP lifecycle helpers pass `CRONTICK_VERBOSE=1` when
  verbose is enabled. The daemon logger uses that env var.
- Run logs: in verbose daemon mode, runner writes concise `[crontick:debug] ...`
  diagnostic lines to the run log for scheduling/spawn/retry/session decisions.

## Stream discipline

CLI stdout is reserved for user-facing results. All log events go to stderr.
When `--json` is set, stdout must contain exactly one JSON document or the
document stream the command already promised; verbose cannot add stdout text.

## Redaction

Logger redaction is applied recursively to event data and strings before any sink
observes an event. Keys matching `token`, `secret`, `password`, `credential`,
`apiKey`, `authorization`, or `cookie` become `[REDACTED]`. Values matching
common bearer tokens, GitHub tokens, AWS keys, and `KEY=value` secrets are also
redacted. Env maps are never logged wholesale; only key names or counts are
diagnostic-safe.
