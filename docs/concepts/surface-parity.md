# Surface Parity

After reading this page you will understand the single-core/thin-shim design principle, how crontick enforces it, and what is required when adding a new capability.

## The single-core principle

crontick exposes the same functionality through three surfaces:

1. **CLI** (`crontick` binary) - for humans in a terminal
2. **MCP server** (`crontick-mcp` binary) - for LLM agents via stdio
3. **Library API** (`import { createClient } from 'crontick'`) - for programmatic use in Node.js

All three are thin adapters over `CrontickClient`, which communicates with the daemon via its loopback HTTP API. No surface contains business logic, scheduling, persistence, or validation. Those responsibilities live exclusively in the daemon and shared core modules.

## The `SURFACE_CAPABILITIES` constant

`src/surface.ts` exports a single constant that canonically enumerates the 29 parity capabilities:

```typescript
export const SURFACE_CAPABILITIES = [
  { capability: 'create-job', clientMethod: 'createJob', cliCommand: ['jobs', 'new'], mcpTool: 'crontick_job_create', optionNames: ['force'] },
  // ... 28 more entries
] as const satisfies readonly SurfaceCapability[];
```

Each entry maps:

| Field | Meaning |
|-------|---------|
| `capability` | Human-readable operation name |
| `clientMethod` | Method on `CrontickClient` |
| `cliCommand` | CLI subcommand path |
| `mcpTool` | MCP tool name |
| `optionNames` | Optional parity-coupled options on that capability |

## Current capability map

| Capability | Client method | CLI command | MCP tool |
|------------|---------------|-------------|----------|
| `create-job` | `createJob` | `crontick jobs new` | `crontick_job_create` |
| `list-jobs` | `listJobs` | `crontick jobs list` | `crontick_job_list` |
| `get-job` | `getJob` | `crontick jobs get` | `crontick_job_get` |
| `update-job` | `updateJob` | `crontick jobs update` | `crontick_job_update` |
| `enable-job` | `enableJob` | `crontick jobs update --enable` | `crontick_job_enable` |
| `disable-job` | `disableJob` | `crontick jobs update --disable` | `crontick_job_disable` |
| `delete-job` | `deleteJob` | `crontick jobs delete` | `crontick_job_delete` |
| `run-now` | `runNow` | `crontick jobs run-now` | `crontick_job_run_now` |
| `job-schedule` | `jobSchedule` | `crontick jobs schedule` | `crontick_job_schedule` |
| `cancel-run` | `cancelRun` | `crontick runs cancel` | `crontick_job_cancel_run` |
| `list-runs` | `listRuns` | `crontick runs list` | `crontick_run_list` |
| `get-run` | `getRun` | `crontick runs get` | `crontick_run_get` |
| `logs` | `getLogs` | `crontick runs logs` | `crontick_run_logs_tail` |
| `delete-run` | `deleteRun` | `crontick runs delete` | `crontick_run_delete` |
| `stats-summary` | `statsSummary` | `crontick stats summary` | `crontick_stats_summary` |
| `stats-job` | `statsJob` | `crontick stats job` | `crontick_stats_job` |
| `export` | `exportJobs` | `crontick share export` | `crontick_export` |
| `import` | `importJobs` | `crontick share import` | `crontick_import` |
| `daemon-start` | `daemonStart` | `crontick daemon start` | `crontick_daemon_start` |
| `daemon-stop` | `daemonStop` | `crontick daemon stop` | `crontick_daemon_stop` |
| `daemon-status` | `daemonStatus` | `crontick daemon status` | `crontick_daemon_status` |
| `daemon-reload` | `daemonReload` | `crontick daemon reload` | `crontick_daemon_reload` |
| `daemon-restart` | `daemonRestart` | `crontick daemon restart` | `crontick_daemon_restart` |
| `doctor` | `doctor` | `crontick doctor` | `crontick_doctor` |
| `dashboard-start` | `dashboardStart` | `crontick dashboard start` | `crontick_dashboard_start` |
| `dashboard-status` | `dashboardStatus` | `crontick dashboard status` | `crontick_dashboard_status` |
| `dashboard-stop` | `dashboardStop` | `crontick dashboard stop` | `crontick_dashboard_stop` |
| `config-path` | `configPath` | `crontick config` | `crontick_config_path` |
| `info` | `info` | `crontick info` | `crontick_info` |

The CLI may fold multiple capabilities into one command path when the operation is an option on a shared command. For example, `enable-job` and `disable-job` are expressed as `crontick jobs update --enable` and `crontick jobs update --disable`.

## The surface-drift test

`tests/surface-drift.test.ts` uses the `SURFACE_CAPABILITIES` array to verify at test time that:

1. Every capability's `clientMethod` exists as a function on `CrontickClient.prototype`.
2. Every client prototype method is either in the capabilities table or in a known non-parity set.
3. Every MCP tool registered by the server matches a capability entry.
4. Every CLI command registered by Commander matches a capability entry.

If any surface adds or removes an operation without updating the others, the test fails.

## What "adding a capability" requires

To add a new operation:

1. **Daemon API** - add the HTTP route in `src/daemon/api.ts`.
2. **Store or domain logic** - implement the behavior in the appropriate daemon module.
3. **CrontickClient** - add the public method.
4. **SURFACE_CAPABILITIES** - add the entry linking all three surfaces.
5. **CLI** - register the Commander subcommand in `src/cli/index.ts`.
6. **MCP** - register the tool in `src/mcp/index.ts`.
7. **Library exports** - if the method or type is public API, export from `src/index.ts`.

Skipping any of these steps will cause the surface-drift test to fail.

## Why shims must contain no business logic

- **Consistency** - users and agents see identical behavior regardless of surface.
- **Testability** - core logic is tested once; shim tests only verify translation.
- **Auditability** - the capability table is the single place to review the system's API surface.
- **Maintainability** - changes to scheduling, validation, or persistence happen in one place.

If a shim needs to transform input, that transformation must call shared functions such as `src/job-input.ts` or `src/config.ts`, never inline the logic.

## Non-parity methods

Some `CrontickClient` methods are intentionally excluded from the parity table because they are internal plumbing, resources, or retained library-only helpers after surface narrowing:

- daemon/client plumbing: `ensure`, `health`, `request`, `baseUrl`, `normalizeOptions`, `shouldStartDaemon`, `effectiveEnv`, `fetchRequest`, `daemonRequestError`
- CLI/resource helpers: `createJobFromCliOptions`, `jobJsonSchema`, `drainNotices`, `isVerbose`
- library-only helpers retained after CLI/MCP narrowing: raw schedule validation/preview, dashboard data, and direct config mutation/engine helpers

These are tracked in the test's `NON_PARITY_CLIENT_METHODS` set.

## Further reading

- [Architecture](../architecture.md) - component diagram and module map
- [Error model](./error-model.md) - how errors translate across surfaces
- [Testing](../testing.md) - the surface-drift test in detail
