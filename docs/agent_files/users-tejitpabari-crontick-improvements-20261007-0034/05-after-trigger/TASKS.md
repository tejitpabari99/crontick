---
status: draft
summary: Eight tasks - schema + time-only guards, store graph + trigger_json, runner hook + RunContext/env, TriggerDispatcher + wiring, API/import guards, job-prepare + client/CLI/MCP/surface, display + dashboard, tests/docs/ADR/changeset.
date: 2026-10-08
---
# Tasks: SP05 `--after` job trigger
Source of truth: docs/agent_files/users-tejitpabari-crontick-improvements-20261007-0034/05-after-trigger/PRD.md. No [OPEN] items remain; three [DEFERRED: verify during implementation] items are mapped to Done-when steps (Tasks 2, 7, 8). Depends on SP01 (`resolveJobRef`, `SCHEDULE_FLAGS`), SP04 (`job-prepare.ts` with injected `resolveJob`, dashboard `SCHEDULE_KINDS`) and SP03 (request guard on mutating routes). SP06 and SP10 consume the dispatcher, `RunContext` and `trigger_json`. No new runtime dependencies.

| # | Task | Depends on | Status |
|---|---|---|---|
| 1 | `after` schema kind and time-only guards | - | done |
| 2 | Store: `listDependents`, graph validation, `trigger_json` | 1 | done |
| 3 | Runner completion hook, `RunContext`, `buildRunEnv` | 1 | done |
| 4 | `TriggerDispatcher` and daemon wiring | 2, 3 | done |
| 5 | API guards: create/update/enable/delete/import, validate/preview | 2, 4 | done |
| 6 | Prepare, client, CLI, MCP, `SURFACE_CAPABILITIES` | 1, 5 | done |
| 7 | Schedule label, display, dashboard entry, share | 5, 6 | done |
| 8 | Tests, docs, ADR 0035, changeset | 1-7 | done |

## Task 1 — `after` schema kind and time-only guards
What it is / what it means: The data shape and the guarantee that non-time schedules never reach time-based machinery (R1, R3 status model, D1, Scheduler/startup).
What changes at a high level: Add `AfterScheduleSchema` (`jobId` GUID, `status` success/failure/any, unknown status rejected) to `ScheduleSchema`. Add an `isTimeSchedule` guard next to it. `Scheduler.schedule` no-ops with a debug log for non-time kinds; `previewNext` and `enumerateFiresBetween` return `[]` via an exhaustive switch so future kinds fail to compile. The startup missed-fire loop skips non-time kinds.
Done when: Schema accepts `after` and rejects bad status; previews and fire enumeration return `[]`; startup records no missed runs for after jobs.

## Task 2 — Store: `listDependents`, graph validation, `trigger_json`
What it is / what it means: Dependency lookups, cycle/dangling checks, and the persisted trigger record (R4, D10).
What changes at a high level: `Store.listDependents(id)` as a full scan of jobs. `validateAfterGraph(job, jobs)` walks upstream pointers and reports `AFTER_CYCLE` (reaches own id; visited-set guards corrupt data) or `AFTER_UPSTREAM_NOT_FOUND`. Add nullable `runs.trigger_json`. `loadJobsFromDisk` still loads schema-valid jobs, then flags dangling or cyclic after-jobs as broken: warn log, not eligible to fire, surfaced to `jobs list` and `doctor`.
Done when: Self, 2-node and 3-node cycles detected. DEFERRED verify: confirm the store's additive-migration pattern before adding `trigger_json` and follow it (existing databases migrate cleanly; rendering stays with SP06). Reload leaves broken jobs inert.

## Task 3 — Runner completion hook, `RunContext`, `buildRunEnv`
What it is / what it means: The exactly-once run-completion event and per-run env injection (R6, D2, D7, D9).
What changes at a high level: Split `recordRunOutcome` into the current body (`recordFailureState`) plus `emitComplete`, so early returns still emit. `Runner.onRunComplete(cb)` listeners run via `queueMicrotask`, each in try/catch, after auto-disable bookkeeping. `runner.run` gains an optional `RunContext` (env, prompt suffix) threaded through the `enqueue` closure so queued runs and retries keep it. Collapse the env merge sites into one `buildRunEnv` with context env last.
Done when: Every terminal run (normal, adopted, reconciled) emits once; overlap-skipped runs never emit; a throwing listener does not crash the daemon; `action.env` cannot override trigger vars; queued runs keep env.

## Task 4 — `TriggerDispatcher` and daemon wiring
What it is / what it means: The shared non-time dispatcher and the `after` listener (D3, D4, D5, D6, D8).
What changes at a high level: New `src/daemon/trigger.ts` with `TriggerDispatcher.dispatch(jobId, req)`: re-read job, skip if missing, disabled or kind mismatch, insert run, persist `trigger_json` (`{kind, upstream}`), call `runner.run` with context; no `recordTick`. The after listener maps terminal status (success; failed/timeout as failure; canceled/skipped/missed never), uses `listDependents`, re-checks the upstream at event time, and builds the five `CRONTICK_*` vars (alias omitted if none). Register it in `daemon/index.ts` after startup reconciliation; log at info when a startup-finalized run had dependents.
Done when: Status-by-filter table fires correctly; one dispatch per run after retries; startup-reconciled and downtime completions fire nothing while adopted runs exiting post-restart do; chain A to B to C fires in order; disabled downstream is silent.

## Task 5 — API guards: create/update/enable/delete/import, validate/preview
What it is / what it means: Authoritative daemon-side enforcement of graph safety (R4, R5).
What changes at a high level: `POST /api/jobs`, `PUT`, and `/enable` call graph validation (dangling and cycle rejected). Single delete refuses with `JOB_HAS_DEPENDENTS` (listing aliases) unless `force`, which disables dependents and leaves their dangling ref inert. Import checks the merged batch+store graph: cycles reported per job and not applied; a dangling upstream imports the job disabled with `AFTER_UPSTREAM_NOT_FOUND` recorded on it while the batch proceeds. `/api/schedules/preview` returns `{fires: [], trigger}` for after; `/validate` checks the upstream exists, with optional `?jobId=` for the cycle check. Relies on SP03's request guard.
Done when: Each guard and error code behaves per R4/R5 on every route; import partial-success verified; renaming an upstream alias leaves the dependent firing.

## Task 6 — Prepare, client, CLI, MCP, `SURFACE_CAPABILITIES`
What it is / what it means: Surface parity for the new schedule and delete `force` (R1, R2, R5, R8).
What changes at a high level: `job-prepare.ts` and `job-input.ts` resolve id-or-alias to a GUID via the injected `resolveJob` before storage. CLI gains `--after <id|alias>` and `--after-status` (default `success`) in `commonJobOptions` for new and update, exactly-one-schedule enforcement, and `--after` appended to `SCHEDULE_FLAGS`; `--after-status` without an after schedule errors. `force` added to single delete across client, CLI (refusal names `--force`, no prompt), MCP and API. Update `SURFACE_CAPABILITIES` and MCP schema descriptions. Shims stay thin.
Done when: Created via alias, stored as GUID; flag misuse errors; `--help` footer lists `--after`; `surface-drift` green.

## Task 7 — Schedule label, display, dashboard entry, share
What it is / what it means: After jobs read clearly everywhere a next-run time shows (R7).
What changes at a high level: New `describeSchedule(schedule, lookup)` in `src/utils/schedule-label.ts` (`after <alias> (on success)`, `after <id8> (missing)`), used by CLI list/get, `jobSchedule` (prints that it is triggered after the alias with no scheduled fire times), and the dashboard payload (`nextRunAt: null` plus `scheduleLabel`) for table and drawer. Add one `after` `SCHEDULE_KINDS` entry (upstream select excluding self, status select, to/from schedule); errors flow through SP04 prepare mode. Update `src/share.ts` as needed.
Done when: All display sites show the label. DEFERRED verify: check whether any `stats` output renders schedule or next-run; if so, route it through `describeSchedule`.

## Task 8 — Tests, docs, ADR 0035, changeset
What it is / what it means: Close out per AGENTS.md and the PRD acceptance criteria.
What changes at a high level: Fill test gaps with fake timers: status x filter table, retries, adopted runs, restart, overlap policies, env, cycles/dangling, import, reload, delete force. Update `docs/concepts/scheduling.md`, `docs/specs/002-scheduling.md` and `001-job-definition.md`, `docs/reference/{cli,mcp,library}`, add ADR 0035 (trigger dispatch, no replay) and a changeset. Run `npm run validate`.
Done when: `npm run validate` green with `surface-drift`. DEFERRED verify: docs recommend `overlap: queue` for fast upstream with slow downstream (skip drops triggers, visible as `skipped`); documentation only, no code.
