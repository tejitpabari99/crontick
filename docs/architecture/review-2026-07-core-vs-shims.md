# Core vs shims architecture review — July 2026

## Verdict

**Partially upheld.** The daemon/store/scheduler/runner still own the durable job JSON, scheduling, run execution, and per-job state writes, and the programmatic client covers most CRUD/run/log/import/export/schedule/daemon/status/dashboard capabilities. However, the single-core principle is not currently enforced across the public edges: MCP bypasses `CrontickClient`, CLI and MCP both contain validation/diagnostic/process logic, and several daemon/MCP capabilities have no client method.

## Public client/core inventory

Public package root exports are `VERSION`, `CrontickError`, `ensureDaemon`, `resolveDaemonBaseUrl`, `CrontickClient`, `createClient`, `normalizeJobInput`, path helpers, and selected schemas/types (`src\index.ts:1-20`). `CrontickClient` public methods are `ensure`, `health`, `createJob`, `listJobs`, `getJob`, `updateJob`, `deleteJob`, `enableJob`, `disableJob`, `runNow`, `getRun`, `listRuns`, `getLogs`, `exportJobs`, `importJobs`, `validateSchedule`, `previewSchedule`, `daemonReload`, `daemonStatus`, and `dashboardUrl` (`src\client.ts:28-135`). Core/internal implementation also exposes daemon/store/scheduler/runner classes and helpers from their source modules, but these are not exported through the package root (`package.json:28-34`, `src\index.ts:1-20`).

## Capability matrix

| Capability | core/client | CLI | MCP | notes |
|---|---|---|---|---|
| Daemon ensure / discover / health | `ensure`, `health`, `ensureDaemon`, `resolveDaemonBaseUrl` (`src\client.ts:28-39`, `src\daemon\ensure.ts:40-53`) | implicit via `client()`, `doctor`, `daemon status` (`src\cli\index.ts:46-48`, `src\cli\index.ts:440-520`, `src\cli\index.ts:587-595`) | `ensureMcpDaemon`, `crontick_daemon_status` (`src\mcp\index.ts:31-40`, `src\mcp\index.ts:376-391`) | MCP status calls `/health`, while client/CLI daemon status call `/api/daemon/status`, so response shapes drift. |
| Create job | `normalizeJobInput`, `createJob` (`src\job-input.ts:46-60`, `src\client.ts:41-44`) | `new <id>` (`src\cli\index.ts:165-285`) | `crontick_job_create` (`src\mcp\index.ts:120-145`) | CLI and MCP do validation/schema work before core; MCP bypasses client normalization. |
| Update job | `updateJob` (`src\client.ts:54-69`) | **missing** | `crontick_job_update` (`src\mcp\index.ts:166-195`) | Core/MCP capability is not exposed in CLI. |
| List jobs | `listJobs` (`src\client.ts:46-48`) | `list` (`src\cli\index.ts:293-303`) | `crontick_job_list`, `crontick://jobs` (`src\mcp\index.ts:147-154`, `src\mcp\index.ts:560-592`) | Present on all surfaces. |
| Get job | `getJob` (`src\client.ts:50-52`) | `get <id>` (`src\cli\index.ts:307-317`) | `crontick_job_get`, `crontick://jobs/{id}` (`src\mcp\index.ts:156-164`, `src\mcp\index.ts:602-631`) | Present on all surfaces. |
| Enable job | `enableJob` (`src\client.ts:75-77`) | `enable <id>` (`src\cli\index.ts:321-331`) | `crontick_job_enable` (`src\mcp\index.ts:209-219`) | Present on all surfaces. |
| Disable job | `disableJob` (`src\client.ts:79-81`) | `disable <id>` (`src\cli\index.ts:333-343`) | `crontick_job_disable` (`src\mcp\index.ts:221-231`) | Present on all surfaces. |
| Delete job | `deleteJob` (`src\client.ts:71-73`) | `delete <id>` (`src\cli\index.ts:345-355`) | `crontick_job_delete` (`src\mcp\index.ts:198-207`) | Present on all surfaces, but MCP description carries confirmation policy in shim. |
| Run job now | `runNow` (`src\client.ts:83-85`) | `run-now <id>` (`src\cli\index.ts:359-369`) | `crontick_job_run_now` (`src\mcp\index.ts:233-244`) | Present on all surfaces. |
| Cancel run | daemon runner/API only (`src\daemon\runner.ts:445-452`, `src\daemon\api.ts:197-201`) | **missing** | `crontick_job_cancel_run` (`src\mcp\index.ts:246-256`) | Known gap: no `CrontickClient.cancelRun`; CLI cannot cancel active runs. |
| List runs | `listRuns` (`src\client.ts:91-98`) | **missing** | `crontick_run_list` (`src\mcp\index.ts:260-277`) | Core/MCP capability is not exposed in CLI. |
| Get run | `getRun` (`src\client.ts:87-89`) | **missing** | `crontick_run_get`, `crontick://runs/{id}` (`src\mcp\index.ts:280-290`, `src\mcp\index.ts:639-668`) | Core/MCP capability is not exposed in CLI. |
| Get logs | `getLogs` (`src\client.ts:100-105`) | `logs <runId> --tail <n>` (`src\cli\index.ts:373-399`) | `crontick_run_logs_tail`, `crontick://runs/{id}/log` (`src\mcp\index.ts:292-311`, `src\mcp\index.ts:676-699`) | Parameter/name drift: CLI `--tail <n>`, MCP `lines`, client always returns full log array. |
| Stream logs | daemon SSE endpoint (`src\daemon\api.ts:216-219`, `src\daemon\api.ts:336-379`) | advertises `--follow` but does not implement streaming (`src\cli\index.ts:374-377`) | **missing** | Daemon capability is not in client/MCP; CLI flag is misleading. |
| Validate schedule | `validateSchedule` (`src\client.ts:116-118`) | **missing command** | `crontick_schedule_validate` (`src\mcp\index.ts:316-327`) | CLI `new` validates only as part of job creation, not as a standalone preview/validation surface. |
| Preview schedule | `previewSchedule` (`src\client.ts:120-125`) | **missing command** | `crontick_schedule_preview` (`src\mcp\index.ts:329-347`) | Core/MCP capability is not exposed in CLI. |
| Stats summary/job | daemon API only (`src\daemon\api.ts:249-280`) | **missing** | `crontick_stats_summary`, `crontick_stats_job` (`src\mcp\index.ts:352-371`) | Known gap: no client `stats` methods; CLI has no stats commands. |
| Export jobs | `exportJobs` (`src\client.ts:107-109`) | `export [--out]` (`src\cli\index.ts:403-420`) | `crontick_export` (`src\mcp\index.ts:438-446`) | Present on all surfaces; CLI file output is formatting/I/O shim behavior. |
| Import jobs | `importJobs` (`src\client.ts:111-114`) | `import <file>` (`src\cli\index.ts:422-435`) | `crontick_import` (`src\mcp\index.ts:448-459`) | Present on all surfaces; MCP bypasses client normalization. |
| Daemon reload | `daemonReload` (`src\client.ts:127-129`) | `daemon reload` (`src\cli\index.ts:598-608`) | `crontick_daemon_reload` (`src\mcp\index.ts:394-402`) | Present on all surfaces. |
| Daemon start | `ensure` can demand-start only (`src\client.ts:28-35`) | `daemon start` (`src\cli\index.ts:534-566`) | implicit ensure only (`src\mcp\index.ts:31-35`) | Explicit lifecycle is CLI-local process logic, not a shared client/core operation. |
| Daemon stop | **missing** | `daemon stop` (`src\cli\index.ts:568-584`) | **missing** | CLI-only direct pid/process logic. |
| Daemon restart | **missing shared helper** | `daemon restart` (`src\cli\index.ts:610-640`) | `crontick_daemon_restart` (`src\mcp\index.ts:404-433`) | Duplicated process-kill/restart logic in shims. |
| Doctor | **missing** | `doctor` (`src\cli\index.ts:439-528`) | `crontick_doctor` (`src\mcp\index.ts:478-554`) | Known gap: no client/core doctor helper; duplicated checks. |
| Dashboard URL/open | `dashboardUrl` (`src\client.ts:135-139`) | `dashboard [--open]` (`src\cli\index.ts:690-716`) | `crontick_dashboard_open` (`src\mcp\index.ts:461-475`) | Core only returns URL; open/browser launch is correctly shim-local. |
| MCP server launcher | **missing / not relevant** | `mcp` (`src\cli\index.ts:720-753`) | MCP entry point `main` (`src\mcp\index.ts:858-868`) | CLI-only host launcher is acceptable shim behavior. |
| MCP resources | Client has corresponding data methods for jobs/runs/logs, but no resource layer | **missing / not relevant** | jobs/job/run/log/schema resources (`src\mcp\index.ts:560-719`) | MCP resource formatting is shim-specific; schema generation is not. |
| MCP prompts | **missing / not relevant** | **missing / not relevant** | `create-scheduled-script`, `investigate-failed-run` (`src\mcp\index.ts:723-851`) | Prompt templates are MCP UX, but they hard-code workflow recommendations. |
| Job JSON schema | Zod schemas exported (`src\schemas\job.ts:5-135`, `src\index.ts:19-20`) but no generated schema artifact | **missing** | generated live in MCP resource (`src\mcp\index.ts:702-719`) | Known gap: schema generation lives in MCP shim, not shared core/build artifact. |
| Persisted per-job JSON state | Store writes and loads `<job>.json` (`src\daemon\store.ts:125-136`, `src\daemon\store.ts:183-203`) | no state writes except import/export files | no state writes; calls daemon | This part is upheld: durable job JSON is produced by daemon store/core, not CLI/MCP. |
| Low-level path/config helpers | exported at package root (`src\index.ts:9-18`, `src\paths.ts:12-45`) | used by CLI (`src\cli\index.ts:8-12`) | used by MCP (`src\mcp\index.ts:12-19`) | Public root leaks daemon storage/pid/port internals. |

## Findings

### 1. P1 — MCP bypasses the public client and duplicates daemon transport/error logic

**Evidence:** MCP defines its own `callDaemon()` fetch wrapper, JSON parsing, timeout, and error construction (`src\mcp\index.ts:40-60`). Most MCP tools then hard-code daemon HTTP endpoints directly (`src\mcp\index.ts:144`, `src\mcp\index.ts:162-164`, `src\mcp\index.ts:192-194`, `src\mcp\index.ts:252-255`, `src\mcp\index.ts:341-347`, `src\mcp\index.ts:359-370`, `src\mcp\index.ts:445-458`). The client already owns corresponding request/error behavior (`src\client.ts:141-183`).

**Why this violates the principle:** MCP is not a thin shim over the programmatic client/core. It is a parallel HTTP client, so endpoint paths, daemon-start policy, timeout behavior, and error shape can drift independently from the public API.

**Recommended fix:** Add the missing client methods listed below, instantiate `CrontickClient` in MCP, and replace direct `callDaemon()` endpoint calls with client calls. Keep MCP-specific schema descriptions and LLM-safe result formatting in MCP.

### 2. P1 — Client is missing MCP/daemon capabilities: `cancelRun`, stats, and doctor

**Evidence:** Daemon cancellation exists in `Runner.cancelRun()` and `/api/runs/:id/cancel` (`src\daemon\runner.ts:445-452`, `src\daemon\api.ts:197-201`), and MCP exposes it as `crontick_job_cancel_run` (`src\mcp\index.ts:246-256`), but `CrontickClient` methods jump from `runNow` to `getRun` with no cancel method (`src\client.ts:83-100`). Stats exist in daemon and MCP (`src\daemon\api.ts:249-280`, `src\mcp\index.ts:352-371`), but the client has no stats methods (`src\client.ts:107-135`). CLI and MCP each implement doctor, but the client has no `doctor()` helper (`src\cli\index.ts:439-528`, `src\mcp\index.ts:478-554`, `src\client.ts:127-135`).

**Why this violates the principle:** Public embedders and tests cannot exercise all daemon/MCP capabilities through the core client. MCP has a structural reason to bypass the client, which entrenches drift.

**Recommended fix:** Add `cancelRun(runId)`, `statsSummary()`, `statsJob(id)`, and `doctor({ startDaemon?: false })` or equivalent typed helpers to `CrontickClient`, then refactor CLI/MCP to use them.

### 3. P1 — CLI `new` contains validation and normalization that belongs in core/client

**Evidence:** The `new` command enforces `--file` exclusivity (`src\cli\index.ts:96-122`), reads and parses job JSON (`src\cli\index.ts:190-198`), builds schedule/action objects (`src\cli\index.ts:200-275`), validates action-source and prompt/session combinations (`src\cli\index.ts:214-233`), normalizes prompt files (`src\cli\index.ts:276`), and validates `JobSchema` before calling `createJob()` (`src\cli\index.ts:279-285`). `createJob()` normalizes the job again (`src\client.ts:41-43`), and `normalizeJobInput()` already performs prompt-file and runtime-arg validation (`src\job-input.ts:46-60`, `src\job-input.ts:62-112`).

**Why this violates the principle:** The CLI is more than parse input → call core → format output. Validation/default construction can diverge from client and MCP behavior, especially for prompt files and prompt/session flags.

**Recommended fix:** Introduce core/client helpers for `buildJobFromCreateOptions` or `createJobFromParts`, including file-base-dir handling, action-source validation, exec splitting policy, and prompt/session validation. CLI should only translate flags into that helper's input.

### 4. P1 — Doctor checks are duplicated in CLI and MCP instead of shared in core

**Evidence:** CLI doctor checks Node, SQLite, data-dir, port file, daemon reachability, dashboard reachability, MCP script existence, and MCP help (`src\cli\index.ts:443-520`). MCP doctor repeats Node, SQLite, data-dir, port file, daemon, dashboard, and MCP script checks (`src\mcp\index.ts:486-553`), with already-drifted wording in its description (`src\mcp\index.ts:479-482`).

**Why this violates the principle:** Diagnostics are product/business logic, not output formatting. Duplicating them in shims means health semantics and failure messages will drift.

**Recommended fix:** Extract a `runDoctorChecks()` core/client helper that returns structured checks without printing or starting the daemon by default. CLI renders checkmarks/exit codes; MCP returns JSON text.

### 5. P1 — Daemon restart/stop/start process logic is duplicated or CLI-only

**Evidence:** CLI `daemon start` spawns the daemon and waits on the port file (`src\cli\index.ts:540-561`); CLI `daemon restart` reads pid files, sends SIGTERM, sleeps, spawns, and waits (`src\cli\index.ts:615-636`). MCP `crontick_daemon_restart` repeats pid-file reads, SIGTERM, port-file polling, and `ensureDaemon()` (`src\mcp\index.ts:411-432`). Shared ensure logic already has locking, stale-lock cleanup, health probing, and safe start (`src\daemon\ensure.ts:53-112`, `src\daemon\ensure.ts:114-199`).

**Why this violates the principle:** Explicit lifecycle behavior can race or fail differently than demand-start behavior. Shims directly mutate process state and read pid/port files.

**Recommended fix:** Move lifecycle operations into shared helpers such as `startDaemonExplicit`, `stopDaemon`, and `restartDaemon` that reuse ensure/probe code. CLI/MCP should call these helpers and only format/confirm results.

### 6. P1 — MCP job schemas duplicate core schema details and omit client prompt-file sugar

**Evidence:** `crontick_job_create` restates the job id regex, enabled, schedule, action, catchup, overlap, retry, and budgets input schema in MCP (`src\mcp\index.ts:120-142`), and `crontick_job_update` repeats similar partial fields (`src\mcp\index.ts:166-188`). Core has authoritative schemas and prompt-file input types (`src\schemas\job.ts:5-135`, `src\job-input.ts:15-31`). CLI exposes `--prompt-file` (`src\cli\index.ts:173-174`), and `normalizeJobInput()` supports `promptFile` (`src\job-input.ts:62-79`), but MCP uses `ActionSchema`, whose prompt action requires `prompt` and has no `promptFile` field (`src\schemas\job.ts:66-74`, `src\mcp\index.ts:129-130`).

**Why this violates the principle:** MCP schema validation is a second source of truth for create/update shape. It also lacks a client/core-supported creation capability (`promptFile`) that CLI has.

**Recommended fix:** Derive MCP input schemas from shared core schemas or shared adapter schemas, and add an MCP-safe prompt-file story only if the MCP host can legitimately reference local files. Otherwise document that MCP accepts prompt text only and keep the limitation explicit in the matrix/tests.

### 7. P1 — Job JSON schema generation lives only in the MCP shim

**Evidence:** MCP imports `zodToJsonSchema` and generates `crontick://schemas/job` inside the resource handler (`src\mcp\index.ts:11`, `src\mcp\index.ts:702-719`). No checked-in `job.schema.json` exists, and the roadmap calls out that the previous generated schema was removed and MCP still exposes a live generated schema (`docs\roadmap\next-steps.md:27`, `docs\roadmap\next-steps.md:242-243`).

**Why this violates the principle:** JSON schema generation is data/schema shaping, not MCP formatting. If MCP is the only place that generates the schema, CLI/client/docs/tests cannot share or verify the same artifact.

**Recommended fix:** Move schema generation to a core/build script or shared module that produces a verified artifact from `JobSchema`. MCP should serve that artifact or call the shared generator; docs should reference the same generated file.

### 8. P2 — Surface parity drift: CLI lacks update/run-inspection/schedule/stats/cancel commands that client or MCP expose

**Evidence:** Client/MCP expose update (`src\client.ts:54-69`, `src\mcp\index.ts:166-195`), run list/get (`src\client.ts:87-98`, `src\mcp\index.ts:260-290`), schedule validate/preview (`src\client.ts:116-125`, `src\mcp\index.ts:316-347`), and MCP/daemon expose stats/cancel (`src\mcp\index.ts:246-256`, `src\mcp\index.ts:352-371`). The CLI command list has `new`, `list`, `get`, `enable`, `disable`, `delete`, `run-now`, `logs`, `export`, `import`, `doctor`, daemon subcommands, `uninstall`, `dashboard`, and `mcp`, but no update, runs, schedule, stats, or cancel command (`src\cli\index.ts:164-185`, `src\cli\index.ts:293-440`, `src\cli\index.ts:532-753`).

**Why this violates the principle:** There is no single parity model for what operations are public. Users and tests cannot assume the CLI mirrors the client/MCP.

**Recommended fix:** Decide which capabilities are intentionally public on each surface. Add missing CLI commands where useful (`update`, `runs list|get`, `schedule validate|preview`, `stats`, `cancel-run`) or document them as API/MCP-only and add parity tests asserting intentional gaps.

### 9. P2 — Parameter and response-shape drift across surfaces

**Evidence:** Logs use CLI `--tail <n>` (`src\cli\index.ts:374-388`), MCP `lines` (`src\mcp\index.ts:292-310`), and client `getLogs(runId)` with no tail/follow options (`src\client.ts:100-105`). Daemon status uses `/api/daemon/status` through the client (`src\client.ts:131-132`, `src\daemon\api.ts:284-290`), while MCP `crontick_daemon_status` calls `/health` directly and returns a different shape (`src\mcp\index.ts:383-390`, `src\daemon\api.ts:73-95`). Schedule preview's default `n` is applied in both daemon API and MCP schema (`src\daemon\api.ts:242-245`, `src\mcp\index.ts:334-337`).

**Why this violates the principle:** Same conceptual operations expose different names, defaults, and response bodies depending on the surface, which makes parity tests and future UI/agent integrations harder.

**Recommended fix:** Define typed core request/response models for logs, daemon status, and schedule preview. Shims may rename flags for UX, but should pass through to the same client methods and document equivalent parameter names.

### 10. P2 — Public root exports leak daemon storage/process internals

**Evidence:** The package root exports `ensureDaemon`, `resolveDaemonBaseUrl`, and low-level path helpers including `pidFilePath` and `portFilePath` (`src\index.ts:3-18`). Those helpers expose data-dir, jobs-dir, runs DB, logs, config, pid, and port file locations (`src\paths.ts:12-45`). `CrontickClientOptions` also inherits implementation-centric ensure options such as `daemonScript`, `allowStart`, `startupTimeoutMs`, `healthTimeoutMs`, and `lockTimeoutMs` (`src\client.ts:15-18`, `src\daemon\ensure.ts:16-24`).

**Why this violates the principle:** The public API leaks daemon transport/storage details that the architecture document says should remain internal/advanced. It is not a chalk/console/process-exit leak, but it is still a shim/daemon implementation concern exposed through core.

**Recommended fix:** Before a stable release, split public root exports from internal/advanced exports. Add a friendlier client option such as `startDaemon?: boolean`, document low-level exports as unstable/advanced or remove them from the package root, and add API surface tests.

### 11. P2 — Prompt runtime validation is duplicated inside core modules

**Evidence:** `job-input.ts` defines reserved prompt args and Windows command-line limit checks (`src\job-input.ts:36-44`, `src\job-input.ts:86-112`). `schemas/job.ts` separately defines the same reserved args and command-line limit checks (`src\schemas\job.ts:54-64`, `src\schemas\job.ts:137-159`).

**Why this violates the principle:** Even before reaching shims, there are two sources of truth for prompt runtime validation and error messages. That makes it easier for CLI/client/MCP behavior to diverge when only one copy is updated.

**Recommended fix:** Extract shared prompt runtime validation constants/functions into one core module used by both the Zod schema refinement and `normalizeJobInput()`.

## Known-gap verification

- `cancelRun`: **gap confirmed.** Daemon/MCP have it; client/CLI do not (`src\daemon\api.ts:197-201`, `src\mcp\index.ts:246-256`, `src\client.ts:83-100`).
- `stats`: **gap confirmed.** Daemon/MCP have summary/job stats; client/CLI do not (`src\daemon\api.ts:249-280`, `src\mcp\index.ts:352-371`, `src\client.ts:107-135`).
- `doctor` helper: **gap confirmed.** CLI/MCP duplicate it; client/core has no helper (`src\cli\index.ts:439-528`, `src\mcp\index.ts:478-554`, `src\client.ts:127-135`).
- MCP/client drift: **confirmed.** MCP owns `callDaemon()` and hard-coded endpoints instead of using `CrontickClient` (`src\mcp\index.ts:40-60`, `src\client.ts:141-183`).
- Per-job JSON state files: **mostly upheld.** Durable job JSON files are written by `Store.upsertJob()` and loaded by `Store.loadJobsFromDisk()` (`src\daemon\store.ts:125-136`, `src\daemon\store.ts:183-203`). CLI/MCP do not write these state files directly.
- Job JSON schema generation: **gap confirmed.** Runtime schema generation is in MCP only, and no generated schema artifact exists (`src\mcp\index.ts:702-719`, `docs\roadmap\next-steps.md:27`).

## Prioritized fix list

1. Add `CrontickClient.cancelRun(runId)`, `statsSummary()`, `statsJob(id)`, and `doctor()` with typed result objects.
2. Refactor MCP tools/resources to use `CrontickClient` for daemon-backed operations; keep only schema descriptions, resource wrapping, redaction, and prompt UX in MCP.
3. Extract shared doctor and daemon lifecycle helpers; replace duplicated CLI/MCP restart/doctor logic.
4. Move job JSON schema generation to a shared core/build module and produce a verified generated artifact; have MCP serve the shared artifact.
5. Refactor CLI `new` so validation/default construction lives in shared core/client helpers, including prompt-file base-dir semantics.
6. Consolidate prompt runtime validation constants/functions used by `schemas/job.ts` and `job-input.ts`.
7. Resolve parity gaps deliberately: add CLI commands for update/runs/schedule/stats/cancel or document/test them as intentional API/MCP-only capabilities.
8. Normalize names/response models for logs, daemon status, schedule preview, and stats across client/CLI/MCP.
9. Split stable public root exports from internal/advanced daemon/path helpers before public release.
