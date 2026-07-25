# Dashboard design

## Current state

- The dashboard is served by `src\daemon\api.ts` from static files under `src\dashboard\`.
- `src\dashboard\dashboard.js` fetches `/health`, `/api/jobs`, `/api/runs`, job details, logs, and mutating job endpoints directly, then builds view-specific data and HTML in the browser.
- Public surfaces expose only a URL: `CrontickClient.dashboardUrl()`, CLI `crontick dashboard [--open]`, and MCP `crontick_dashboard_open`.
- There is no `scripts\` dashboard entry point today, but the browser script is a second dashboard logic surface.

## Target module layout

- `src\dashboard.ts` is the core dashboard module. It owns dashboard data aggregation, status/start/stop result shapes, URL construction, and static asset path resolution.
- `src\daemon\api.ts` delegates `/api/dashboard`, `/api/dashboard/status`, and static asset serving to `src\dashboard.ts`.
- `src\client.ts` exposes typed dashboard methods and hides daemon transport/ensure details.
- `src\cli\index.ts` and `src\mcp\index.ts` are thin shims: parse params, call the same client methods, render JSON/human/MCP text.
- `src\dashboard\dashboard.js` becomes a small browser renderer over `/api/dashboard`; it no longer gathers from multiple endpoints, mutates jobs, or duplicates dashboard data shaping.

## Core API surface

```ts
interface DashboardOptions { runsLimit?: number; jobId?: string }
interface DashboardStatus { ok: true; running: boolean; url: string; port?: number; pid?: number; daemon: unknown }
interface DashboardStartResult extends DashboardStatus { startedDaemon: boolean }
interface DashboardStopResult { ok: true; running: boolean; stopped: boolean; message: string; pid?: number }
interface DashboardData { generatedAt: number; health: DashboardHealth; stats: StatsSummary; jobs: DashboardJob[]; runs: DashboardRun[] }
```

Client methods:

- `dashboardStart(): Promise<DashboardStartResult>`
- `dashboardStop(): Promise<DashboardStopResult>`
- `dashboardStatus(): Promise<DashboardStatus>`
- `dashboardData(options?: DashboardOptions): Promise<DashboardData>`

Daemon/core helpers:

- `buildDashboardData(ctx, options)` constructs the dashboard model from `Store` only.
- `dashboardStatusFromDaemon(ctx)` constructs status for a live daemon.
- `dashboardUrl(baseUrl)` returns `${baseUrl}/dashboard`.
- `resolveDashboardAsset(reqPath)` resolves static assets safely inside `src\dashboard`/`dist\dashboard`.

## Dashboard data model

- `health`: product, version, uptime seconds, pid, port, node, platform, job/run counters.
- `stats`: total jobs, enabled jobs, total runs, succeeded, failed, average duration.
- `jobs`: id, description, enabled, scheduleLabel, actionKind, lastStatus, lastRunAt, nextRunAt (nullable), raw job.
- `runs`: id, jobId, status, startedAt, endedAt, durationMs, exitCode, error.

## Public surfaces

CLI commands, all respecting global `--json`:

- `crontick dashboard start [--open]`
- `crontick dashboard status`
- `crontick dashboard data [--job <id>] [--runs-limit <n>]`
- `crontick dashboard stop`

MCP tools mirror client/CLI operation names and response shapes:

- `crontick_dashboard_start`
- `crontick_dashboard_status`
- `crontick_dashboard_data`
- `crontick_dashboard_stop`

The old URL-only `dashboardUrl`, `crontick dashboard`, and `crontick_dashboard_open` are removed instead of deprecated.

## Error cases

- Daemon down on `dashboardStatus`/`dashboardData`: `DAEMON_NOT_RUNNING` with message `Dashboard daemon is not running. Start it with: crontick dashboard start`.
- Start failure: reuse daemon ensure/lifecycle typed errors and preserve `npm run build` / `crontick daemon start` actions.
- Port/unreachable URL failure: include the exact URL/port probed and action `crontick dashboard start` or `crontick daemon status`.
- Asset traversal: return 400 `BAD_DASHBOARD_ASSET` without exposing files outside the dashboard asset directory.

## What gets deleted

- Delete old URL-only public surface names.
- Delete browser-side job creation, enable/disable/delete/run-now, multi-endpoint aggregation, and SSE log streaming from `src\dashboard\dashboard.js`/HTML.
- Delete docs that describe `crontick dashboard [--open]` or `crontick_dashboard_open`.
- Delete any discovered `scripts\*dashboard*` entry point (none currently exists).

## Ordered implementation plan

1. Add `src\dashboard.ts` core types/helpers and unit tests for model construction and asset safety.
2. Add daemon `/api/dashboard` and `/api/dashboard/status` endpoints that call the core helpers.
3. Add client dashboard start/status/data/stop methods and typed tests, including daemon-down errors.
4. Replace CLI/MCP surfaces and extend surface-drift, CLI, and MCP tests.
5. Simplify dashboard static HTML/JS to render the core data model only.
6. Update docs and roadmap, then run full verification and self-review.

## Test plan

- Core: `buildDashboardData` maps jobs/runs/stats and `resolveDashboardAsset` rejects traversal.
- Server: `/api/dashboard`, `/api/dashboard/status`, `/dashboard`, JS/CSS assets, and traversal responses.
- Client: start/status/data/stop methods, daemon-down guidance, and unreachable configured URL includes the probed port.
- CLI: `dashboard start/status/data/stop`, human rendering, and `--json`.
- MCP/surface drift: matching `crontick_dashboard_*` tools and client/CLI/MCP parity table coverage.
