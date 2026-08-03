# 0024: Reorganize CLI commands and narrow high-risk exposure

- Status: Accepted
- Date: 2026-08-02

## Context

The original CLI grew as a flat list of commands. Jobs, runs, schedule utilities, config mutation, sharing, daemon control, dashboard control, and one-off admin helpers all lived at the top level. That made help output hard to scan and made related operations look unrelated. Errors were also too noisy for command-line use: Commander usage errors and thrown exceptions could surface multi-line output or Node stack traces when the actionable message was a single validation failure.

The CLI and MCP surfaces also exposed too much low-level machinery directly. Dedicated `script` and `exec` flags, config get/set/unset/init/validate commands, engine-management commands, raw schedule validation/preview, and dashboard data were useful for early development but cluttered the public surface. They also duplicated behavior already available through the job schema or the library API. At the same time, the GUID-plus-alias identity model meant the create path should no longer ask the user for the immutable primary key.

## Decision

Reorganize the CLI around nouns:

- `jobs` for create, update, list, get, schedule preview, delete, and run-now.
- `runs` for history listing, detail, logs, cancel, and deletion.
- `stats` for summary and per-job stats.
- `share` for export/import.
- existing `daemon`, `dashboard`, `doctor`, and `mcp` commands remain grouped by responsibility.

`crontick jobs new` no longer accepts an id positional. crontick assigns a GUID automatically and accepts `--alias <name>` for the human-friendly identifier; when omitted, an alias is generated. `jobs update <id>` accepts either GUID or alias and also owns `--enable` / `--disable`, replacing standalone enable/disable commands. `jobs schedule <id>` replaces raw schedule preview for the CLI and MCP parity surface. `runs cancel` replaces `cancel-run`, and `runs delete` adds a way to remove one run or all runs plus their crontick-side log rows.

`config` is now a read-only locator command: it prints the config file path and explains that users edit `config.json` by hand. The config mutation and engine-management CLI/MCP commands are removed. `info` is added to show version, Node/platform, storage paths, and daemon running status.

The CLI removes the global `--json` flag and always prints human-readable output. Command failures now render one clean stderr line, `error: [CODE] message` or `error: message`, colored red when stderr is a TTY and `NO_COLOR` is not set. `--verbose` adds details and stack output for debugging. Commander usage errors use the same presentation.

Script and exec **actions** remain fully supported in the persisted job schema, daemon executors, and core client. The narrowing is only at the dedicated CLI flag/MCP convenience-parameter layer: create those jobs through `crontick jobs new --file <job.json>` or `client.createJob()`.

The surface parity table is updated from 37 to 29 capabilities. Removed parity rows include config mutation/engine tools, raw schedule validate/preview, and dashboard data. Added or renamed rows include `job-schedule`, `delete-run`, `config-path`, and `info`, plus grouped CLI command paths such as `jobs new`, `runs list`, and `share export`.

The library API remains backward-compatible and additive: existing client helpers are retained as library-only methods where they no longer participate in CLI/MCP parity, and new methods such as `info`, `deleteRun`, `jobSchedule`, and `configPath` are added.

## Alternatives considered

**Keep flat commands and add aliases for grouped commands.** Rejected. Aliases would preserve the old clutter and keep two command vocabularies alive indefinitely, making docs and support harder.

**Remove script and exec actions entirely.** Rejected. These action kinds are core product behavior and remain necessary for programmatic and advanced JSON-defined jobs. Only their dedicated shim exposure was narrowed.

**Keep config mutation on the CLI/MCP surfaces.** Rejected. Editing one JSON file by hand is simpler than maintaining a parallel command grammar, especially when most settings apply on the next run. The library helpers remain available for programmatic use.

**Keep global `--json`.** Rejected. It complicated every CLI command and error path. Structured automation should use the library or MCP surface instead.

## Consequences

**Easier / safer:**

- CLI help is organized by task area instead of a long flat list.
- Job creation matches the GUID/alias identity model and no longer asks users to invent primary keys.
- Common run lifecycle operations are discoverable under `runs`, including deletion.
- Config is simpler to explain: find the file, edit it, and restart only for `retention.maxRunsPerJob`.
- Human CLI errors are concise and consistent, without default stack traces.
- `SURFACE_CAPABILITIES` is smaller and easier to audit.

**Harder / accepted tradeoffs:**

- Users with scripts that call old flat commands must migrate to grouped commands.
- CLI users who need script or exec actions must provide a job JSON file instead of flags.
- CLI users who need structured JSON output must use the library or MCP surface.
- Direct config mutation is no longer available through CLI/MCP, so documentation must clearly point to the config file and runtime application rules.

## Revisit when

Revisit if usage shows that the JSON-file path is too cumbersome for script/exec jobs, or if a future automation use case requires a structured CLI output contract that cannot be met by the library or MCP surfaces.

## Amendment (2026-08-03): Remove the `dashboard` command group; surface the URL in `info`

Following the reorganization above, the `dashboard start`/`status`/`stop` CLI commands and the matching `crontick_dashboard_start`/`crontick_dashboard_status`/`crontick_dashboard_stop` MCP tools were removed. The dashboard is **always** served by the daemon on its loopback origin (routes `/`, `/dashboard`, `/dashboard/*`, `/api/dashboard`) whenever the daemon is running. A dedicated command group implied the dashboard was a separately startable/stoppable service, which it is not: `dashboard start` just demand-started the daemon, and `dashboard stop` was an alias for `daemon stop`.

Instead, `crontick info` (and `crontick_info`) now include a `dashboardUrl` field — the daemon-served dashboard URL (for example `http://127.0.0.1:<port>/dashboard`), or `null` when it cannot be resolved (no running daemon and no readable port file). `info` remains strictly read-only and never starts the daemon. Users open the URL in a browser; the daemon (and thus the dashboard) starts automatically on first use of any daemon-backed command.

This drops the surface parity table from 29 to 26 capabilities (removing `dashboard-start`, `dashboard-status`, `dashboard-stop`). The dashboard itself — assets, `buildDashboardData`, and the `/api/dashboard` routes — is unchanged and still fully served by the daemon. The `dashboardStart`/`dashboardStop` client methods were removed (they only made sense as commands), while `dashboardStatus`/`dashboardData` are retained as library-only helpers (excluded from parity). Exported dashboard result types (`DashboardStartResult`, `DashboardStopResult`, etc.) remain exported for backward compatibility.
