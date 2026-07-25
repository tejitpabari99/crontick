# Fluff audit

Date: 2026-07-25
Branch: users/tejitpabari/prompt-cron-daemon-autostart

Owner intent: start with strong basics; less surface means less to test. Architecture constraint: one core with thin CLI/MCP/client shims, no drift between surfaces.

## Summary

| Verdict | Count |
|---|---:|
| REMOVE | 8 |
| COLLAPSE | 2 |
| KEEP | 7 |

## Candidates

| Verdict | Risk | Candidate | Evidence | Justification |
|---|---|---|---|---|
| COLLAPSE | Low | Duplicate CLI log count flags | Done: logs now expose one `--tail` count flag. | Keep one user-facing name for one behavior. |
| COLLAPSE | Low | Schedule preview count flag name | Done: schedule preview now exposes `--limit` for preview count. | Keep the CLI name aligned with count semantics. |
| REMOVE | Medium | CLI/client destructive purge surface | Done: users can remove package/data with standard OS/package-manager commands. | Not part of the core scheduler value proposition. |
| REMOVE | Low | Duplicate MCP read resources for jobs/runs/config | `src\mcp\index.ts:509-656` exposes `crontick://config/effective`, `crontick://jobs`, job/run/log templates, all duplicating tools. | MCP tools already cover list/get/log/config operations through the client; these resources are MCP-only drift-prone convenience surface. |
| KEEP | Low | MCP `crontick://schemas/job` resource | `src\mcp\index.ts:659-674` serves the shared job JSON schema through `client.jobJsonSchema()`. | Per-job JSON schema generation is explicitly core value and this is the AI-friendly way to inspect the authoritative shape. |
| REMOVE | Low | MCP prompt templates | `src\mcp\index.ts:679-802` adds `create-scheduled-script` and `investigate-failed-run`. | They are workflow prose, not scheduler primitives; `create-scheduled-script` is script-first while the product is prompt-first, and both duplicate existing tools. |
| REMOVE | Low | Custom cron alias expansion wrapper | `src\daemon\scheduler.ts:7-24` maps aliases before passing to Croner; `tests\aliases.test.ts:4-39` exists only for this wrapper. | Croner already accepts standard aliases such as `@daily`; custom `@every_minute` is extra syntax to document and test. Use standard cron/Croner behavior. |
| REMOVE | Low | Unused coverage provider dependency | `package.json:65` depends on `@vitest/coverage-v8`; `vitest.config.ts:45-48` configures coverage, but `package.json:48-51` has no coverage script. | No current workflow consumes coverage. Remove the direct dev dependency and config until coverage is actually used. |
| REMOVE | Low | Unused config JSON schema export | `src\schema-json.ts:15-22` and `src\index.ts:27` export config schema generation; grep shows production code/tests only need job schema text/resource. | Config validation uses Zod directly. Do not ship an unused public schema helper. |
| REMOVE | Low | Completed/stale design and review docs | `docs\architecture\core-refactor-plan.md:1-67`, `feature-batch-design.md:1-57`, `config-design.md:1-110`, `dashboard-design.md:1-97`, `logging-design.md:1-85`, `review-2026-07-core-vs-shims.md:1-43`. | These are historical plans/reviews now duplicated by current docs. Keep durable architecture in `docs\architecture.md` and this audit. |
| KEEP | Medium | Stats summary/job surfaces | `src\surface.ts:23-24`, `src\client.ts:204-210`, `src\mcp\index.ts:286-303`, `src\cli\index.ts:388-394`. | Although arguably derived data, stats support status/history basics and are present consistently across all surfaces. Removing them would reduce observability. |
| KEEP | Medium | Config system and engine CRUD | `src\surface.ts:35-43`, `src\config.ts:47-209`, `src\cli\index.ts:396-438`, `src\mcp\index.ts:426-505`. | Config is explicitly protected and needed for prompt engine startup; generic get/set and engine commands are current, tested behavior. |
| KEEP | Medium | Dashboard lifecycle/data | `src\surface.ts:31-34`, `src\client.ts:246-276`, `src\mcp\index.ts:371-411`, `src\cli\index.ts:537-572`. | Dashboard is explicitly protected; it is thin over core data and tested for drift. |
| KEEP | Medium | Prompt session-id and reuse handling | `src\schemas\job.ts:60-61`, `src\job-input.ts:217-225`, `src\daemon\runner.ts:240-259`, `src\daemon\store.ts:146-162`. | Session-id handling is explicitly protected and central for prompt jobs. |
| KEEP | Medium | Timeout/env/envFile/cwd action fields | `src\schemas\job.ts:32-37`, `src\daemon\runner.ts:264-295`, `docs\security.md:35`. | These are safety/operational basics: process location, time bounding, and secrets via environment instead of prompt text. |
| KEEP | High | Retry, overlap policy, and maxRunsPerDay budgets | `src\schemas\job.ts:77-99`, `src\daemon\runner.ts:82-190`, `tests\integration.retry.test.ts:15-66`, `tests\integration.overlap.test.ts:34-91`, `tests\integration.budget.test.ts:1-129`. | They are more advanced than CRUD, but they are actively consumed, heavily tested, and provide safety under repeated schedules. Leave for owner decision rather than delete in this pass. |
| KEEP | Medium | Catchup field | `src\schemas\job.ts:96`, `src\daemon\scheduler.ts:182-203`, `src\daemon\scheduler.ts:213-227`, `docs\schedules.md:50-54`. | It is extra scheduler behavior, but default is `skip` and deleting persisted behavior plus tests is higher-risk. Owner should decide separately. |
