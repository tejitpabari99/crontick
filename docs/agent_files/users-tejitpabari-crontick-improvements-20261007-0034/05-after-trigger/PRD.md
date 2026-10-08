---
status: draft
summary: SP05 --after trigger (Phase 3) - new `after` schedule kind fired by upstream run completion, with a single run-completion hook, cycle/dangling-ref guards, env injection, and a shared non-time trigger dispatcher that SP06 reuses.
date: 2026-10-07
---

# PRD: `--after` job trigger

Repo/branch: `/root/projects/crontick-wt-improvements`, `users/tejitpabari/crontick-improvements` · Depends on: SP01 (`resolveJobRef`, `SCHEDULE_FLAGS`), SP04 (`src/job-prepare.ts`, dashboard `SCHEDULE_KINDS`) · Owns: `src/schemas/job.ts` (+`AfterScheduleSchema`), `src/daemon/trigger.ts` (new), `src/daemon/runner.ts` (completion hook, `RunContext`), `src/daemon/index.ts` (wiring, startup skip), `src/daemon/scheduler.ts` (non-time no-ops), `src/daemon/store.ts` (`listDependents`, graph validation, `trigger_json`), `src/daemon/api.ts` (create/update/enable/delete guards, validate/preview), `src/job-prepare.ts` + `src/job-input.ts`, `src/utils/schedule-label.ts` (new), `src/client.ts`, `src/cli/`, `src/mcp/`, `src/surface.ts`, `src/dashboard*`, `src/share.ts`, docs, changeset, ADR 0035.

## TL;DR

Add schedule kind `after`: `{kind:'after', jobId:<upstream GUID>, status:'success'|'failure'|'any'}`. A new `onRunComplete` hook fires from the one choke point every terminal run already passes (`Runner.recordRunOutcome`); a `TriggerDispatcher` finds enabled dependents and starts a run through the normal runner (so overlap/retry/timeout apply), injecting `CRONTICK_UPSTREAM_*` env. The dispatcher is deliberately generic: SP06 `webhook` reuses it unchanged.

## Problem

Jobs can only fire on time. Users want "run B when A finishes" (build then deploy, failure alert) without polling or cron offsets. Verified: no run-completion event exists; `Scheduler` emits only `tick` and the daemon handler (`daemon/index.ts:~286`) is time-specific `[verified: read]`. `previewNext` returns `[]` for unknown kinds, and the startup missed-fire loop calls `enumerateFiresBetween` for every enabled job `[verified: scheduler.ts:80-140, index.ts:200-255]`.

## Goals / Non-Goals

**Goals:** `--after` across client/CLI/MCP/API/dashboard; exactly-once dependent dispatch per terminal upstream run; safe graph (no cycles, no silent dangling refs); upstream context visible to the downstream prompt.
**Non-Goals:** multiple upstreams/AND-joins; passing upstream output (use `crontick runs get "$CRONTICK_UPSTREAM_RUN_ID"`); delay/debounce; replay of completions missed while the daemon was down; changing `tick` dispatch.

## Requirements

| # | Requirement |
|---|---|
| R1 | Schema `after` joins `ScheduleSchema`; `jobId` is a GUID, never an alias (aliases are user-editable; `Store.getJob` resolves id-then-alias `[verified: schemas/job.ts alias docs]`). Inputs accept id-or-alias; resolved to GUID before storage. |
| R2 | CLI `--after <id\|alias>`, `--after-status <success\|failure\|any>` (default `success`) in `commonJobOptions` (new + update); exactly one of `--cron/--every/--at/--after/--webhook`; `--after-status` without an after schedule (new, or update of a non-after job) errors. Append `--after` to `SCHEDULE_FLAGS` (SP01). |
| R3 | Trigger set: terminal upstream run of any origin (scheduled, run-now, webhook), after retries. `success` -> `success`; `failure` -> `failed` or `timeout`; `any` -> either. `canceled`/`skipped`/`missed` never trigger. |
| R4 | Cycles (incl. self) rejected on create, update, enable, import, reload. Dangling upstream rejected on create/update/enable; on import a dangling upstream imports the job disabled with an `AFTER_UPSTREAM_NOT_FOUND` error recorded on the job (rest of batch proceeds); cycles on import still rejected. Codes: `AFTER_CYCLE`, `AFTER_UPSTREAM_NOT_FOUND`. |
| R5 | Delete of a job with dependents -> `JOB_HAS_DEPENDENTS` (lists aliases) unless `force`; force disables dependents (they keep the dangling ref, inert until re-pointed). `force` added to single delete on client/CLI/MCP/API. |
| R6 | Downstream env: `CRONTICK_TRIGGER=after`, `CRONTICK_UPSTREAM_RUN_ID`, `CRONTICK_UPSTREAM_STATUS` (`success\|failed\|timeout`), `CRONTICK_UPSTREAM_JOB_ID`, `CRONTICK_UPSTREAM_JOB_ALIAS` (omitted if no alias). Highest merge priority (above `action.env`). |
| R7 | Display: wherever next-run shows a time, an after job shows `after <alias> (on success)` (alias resolved at read time; `after <id8> (missing)` if dangling). |
| R8 | Surface parity: `SURFACE_CAPABILITIES` entries updated (create/update/delete force), MCP schema descriptions, `surface-drift` green. |

## Architecture

**Completion hook (where, exactly once).** `recordRunOutcome` is the single recorder for normal runs (after retries), adopted runs and reconciled runs `[verified: runner.ts:432,445; adopted at :285]`. It has early `return`s, so restructure: current body becomes `recordFailureState`, and `recordRunOutcome` = run it, then `emitComplete`. `Runner.onRunComplete(cb)` keeps listeners; `emitComplete` invokes them via `queueMicrotask`, each in try/catch (a throw must not reach `uncaughtException`; same lesson as the tick handler comment). Emitted after auto-disable bookkeeping, so the run that disables the upstream still triggers `failure/any` dependents. Overlap-`skipped` runs never reach it (early return in `run()` `[verified: runner.ts:308]`); canceled reach it but are filtered by R3. Exactly once: each run id passes `recordRunOutcome` once; the adopted path is guarded by `run.status === 'running'`.

**Restart mid-chain.** The listener is registered in `daemon/index.ts` AFTER startup reconciliation, so runs finalized at startup (marker-derived or `DAEMON_RESTART` canceled) do NOT fire dependents. Completions that happened while the daemon was down are not replayed: consistent with the report-only missed-fire stance, avoids surprise runs/storms. Adopted runs that exit after restart do fire (daemon is live). Info log when a startup-finalized run had dependents. Documented: a chain interrupted by downtime stops; next scheduled upstream run resumes it.

**Shared non-time dispatcher (SP06 reuses).** `src/daemon/trigger.ts`:
```ts
export interface TriggerRequest {
  kind: 'after' | 'webhook';            // SP06 adds 'webhook'; the union grows only here
  env: Record<string, string>;          // CRONTICK_TRIGGER + kind-specific vars
  meta?: Record<string, unknown>;       // persisted to runs.trigger_json (SP06 stores payload, capped)
  promptSuffix?: string;                // SP06: fenced payload appended to prompt; unused by after
}
export class TriggerDispatcher {
  constructor(deps: { store: Store; runner: Runner; logger: Logger });
  dispatch(jobId: string, req: TriggerRequest):
    { runId: string } | { skipped: 'not-found' | 'disabled' | 'kind-mismatch' };
}
```
`dispatch`: re-read the job from the store (like tick), skip if disabled or `schedule.kind !== req.kind` (an edited job never fires on a stale event), `store.insertRun`, persist `trigger_json`, call `runner.run(job, runId, store, { env, promptSuffix })`. No `recordTick`: the watermark is time-only. `runner.run` gains an optional 4th `RunContext`, threaded through the `enqueue` closure so queued runs keep their env. The `after` listener: `store.listDependents(upstreamId)` (full scan of `listJobs()` per event; N is small and this avoids a cache that reload would invalidate) -> filter by status/enabled -> `dispatch`. A downstream completion re-enters the hook, so A->B->C works with no extra code. SP06's `jobs trigger`, `POST /api/jobs/:id/trigger` and relay SSE call `dispatch(jobId, {kind:'webhook', ...})`. SP10 hard-depends on this SP (`RunContext`/`buildRunEnv`, `isTimeSchedule`, listener-after-reconcile ordering). Two dispatch functions are kept on purpose: `TriggerDispatcher.dispatch` (non-time events, no `recordTick`) and SP10 `dispatchTimeRun` (time fires, with `recordTick`); merging them would blur the time-only watermark rule.

**Env injection.** Today env merges at two sites (`runner.ts:557` and `:571-577`: process.env < engine env < envFile < action.env) plus the transcript-path call `[verified: grep env runner.ts]`. Collapse to one `buildRunEnv(promptEnv, envFile, action.env, ctx.env)` helper with `ctx.env` last. Adapters are unchanged: they receive the same `spawnOpts.env`. Retries reuse the same context.

**Scheduler / startup.** Add an `isTimeSchedule(s)` guard next to the schema; `Scheduler.schedule` no-ops (debug log) for non-time kinds, `previewNext`/`enumerateFiresBetween` return `[]` via an exhaustive switch (compile error on future kinds). Startup missed-fire loop `continue`s for non-time kinds. SP06 inherits these guards.

**Graph validation.** `Store.listDependents(id)` and `validateAfterGraph(job, jobs)`: walk `jobId` pointers from the proposed upstream; cycle iff the walk reaches `job.id` (one upstream per node => O(depth); a visited-set guards corrupt data). Called by `POST /api/jobs`, `PUT`, `/enable`, and import (checked on the merged batch+store graph; cycles: per-job failures reported, after-jobs in a failing graph not applied; dangling upstream: job imported disabled with `AFTER_UPSTREAM_NOT_FOUND` recorded on the job and reported, rest of batch proceeds). **Reload / file edit:** `loadJobsFromDisk` still loads schema-valid jobs, but a post-pass flags dangling/cyclic after-jobs: warn log, not eligible to fire, `jobs list` shows `(broken: upstream missing)`, `doctor` reports; the dispatcher also re-checks the upstream at event time.

**Display.** New `describeSchedule(schedule, lookup)` in `src/utils/schedule-label.ts` used by CLI list/get, `jobSchedule` (prints `triggered after <alias> on success; no scheduled fire times`), and the dashboard payload (`dashboard.ts:310` yields `nextRunAt: null` plus `scheduleLabel`) for table and drawer. `/api/schedules/preview` returns `{fires: [], trigger: {...}}` for after. `/api/schedules/validate` for after checks the upstream exists (+ optional `?jobId=` for the cycle check on update).

**Dashboard.** One `SCHEDULE_KINDS` entry `after` (upstream `<select>` from jobs minus self, status select, `toSchedule`/`fromSchedule`) per SP04 D7. Resolution/cycle errors flow through SP04 prepare mode: `job-prepare.ts` takes an injected `resolveJob` (provided by SP04; client passes an API lookup, daemon passes `store.getJob`); client/shims hold no cycle logic, the daemon API is authoritative.

**Export/import.** References are GUIDs and exports carry job ids (import upserts by id), so intra-export chains survive; alias is display only. Importing a lone downstream elsewhere imports it disabled with an `AFTER_UPSTREAM_NOT_FOUND` error (R4).

## Decisions

| # | Decision | Alternatives | Rationale |
|---|---|---|---|
| D1 | Store upstream GUID | Store alias | Aliases are editable; GUID survives renames |
| D2 | Hook at `recordRunOutcome` | EventEmitter on store; poll runs table | Existing single exactly-once point incl. adopted runs |
| D3 | `timeout` counts as failure | Separate status | Matches auto-disable semantics; env var still reveals `timeout` |
| D4 | No replay after downtime | Fire on restart | No storms; matches report-only missed-fire policy |
| D5 | Disabled downstream: silent (debug log), no run row | Record `skipped` | Same as a disabled cron job (unscheduled) |
| D6 | Disabled/auto-disabled upstream: manual runs still trigger; the disabling run triggers | Block | "Any terminal run" rule; failure-alert use case |
| D7 | Overlap policy applies via `runner.run` | Bypass | `skip` records a visible `skipped` run; `queue`/`cancel-previous` as usual |
| D8 | Shared `TriggerDispatcher` | After-specific path | SP06 needs identical re-read/insert/run/env steps |
| D9 | Trigger env has top priority | Below `action.env` | `CRONTICK_*` must not be shadowed |
| D10 | Add nullable `runs.trigger_json` | None | SP05 stores `{kind, upstream}`; SP06 renders it in `runs get`/dashboard and stores the webhook payload |

## Risks / Open Questions

- [DEFERRED: verify during implementation] `runs.trigger_json`: confirm the store's additive-migration pattern. [RESOLVED: rendering in `runs get`/dashboard belongs to SP06 (its R12); SP05 only stores `{kind, upstream}`]
- [DEFERRED: verify during implementation — docs recommend `overlap: queue`, no code] Fast upstream + slow downstream with `skip` drops triggers (visible as `skipped`); proposed: docs recommend `overlap: queue`, no code.
- [DEFERRED: verify during implementation] Does any `stats` output render schedule/next-run? Not verified; if so use `describeSchedule`.
- [RESOLVED: owner decision, import the job disabled with an `AFTER_UPSTREAM_NOT_FOUND` error on the job; rest of the import succeeds] Import with an unresolved ref: fail vs import disabled. (R4)
- [RESOLVED: CLI delete with dependents refuses, naming `--force`; no interactive prompt] (R5)
- [RESOLVED: dependents fire on adopted-run exit, not on startup reconcile] see Architecture.
- [RESOLVED: single-upstream cycle detection is a pointer walk] no DFS needed.
- [DEFERRED] Multi-upstream joins, upstream-output passing, chain depth cap (cycle-free, so finite).
- Risk: microtask emission racing the auto-disable read; mitigated by emitting after bookkeeping and re-reading jobs at event time.

## Acceptance Criteria

- Schema accepts `after`, rejects unknown status; stored `jobId` is the GUID even when created via alias; renaming the upstream alias leaves the dependent firing.
- Table-driven test: upstream statuses (success, failed, timeout, canceled, skipped, missed) x `--after-status` -> fires or not; one fire only after retries are exhausted; exactly one dispatch per run, adopted runs included (fake timers).
- Restart test: completion during downtime and startup-reconciled runs fire nothing; an adopted run exiting after restart fires.
- Run-now (and SP06 webhook) upstream runs fire dependents; chain A->B->C fires in order.
- Downstream overlap `skip|queue|cancel-previous` each behave; queued run keeps env; disabled downstream does not run.
- Env test with a fake engine: all five vars present, alias var omitted when none, `action.env` cannot override.
- Cycles (self, 2-node, 3-node) rejected on create/update/enable/import; dangling rejected on create/update/enable; dangling on import imports the job disabled with `AFTER_UPSTREAM_NOT_FOUND` and the rest of the batch succeeds; file-edit reload leaves a broken job inert with warning and `doctor` entry; delete refused with dependents, `--force` disables them.
- `enumerateFiresBetween`/`previewNext` return `[]` for `after`; startup records no missed runs for after jobs.
- CLI list/get/schedule, dashboard table+drawer and preview endpoint show `after <alias>`; `--help` footer lists `--after`; `surface-drift` and `npm run validate` green.
- Docs updated: `docs/concepts/scheduling.md`, `docs/specs/002-scheduling.md` + `001-job-definition.md`, `docs/reference/{cli,mcp,library}`, ADR 0035 (trigger dispatch + no-replay), changeset.
