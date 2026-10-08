---
status: draft
summary: SP10 - per-job opt-in catch-up (job-level `catchUp` boolean, default off): on daemon start the latest missed fire runs once, the rest are recorded `skipped`.
date: 2026-10-07
---

# PRD: Catch-up (SP10, Phase 4)

Repo/branch: `/root/projects/crontick-wt-improvements`, `users/tejitpabari/crontick-improvements` · Depends on: SP05 (hard: `isTimeSchedule`, `RunContext`/`buildRunEnv`, listener-after-reconcile ordering), SP04 (soft: `job-prepare.ts`, `SCHEDULE_KINDS`), SP01 (`commonJobOptions`) · Owns: `src/schemas/job.ts`, `src/job-input.ts`, `src/daemon/index.ts` (startup reconcile), `src/daemon/scheduler.ts` (`latestFireBefore`, interval `startAt`), `src/daemon/store.ts` (`recordSkippedRun`), `src/client.ts`, `src/cli/`, `src/mcp/`, `src/surface.ts`, `src/dashboard/*` (one field), `docs/concepts/scheduling.md`, `docs/specs/{003,004,006}`, `docs/decisions/0001` (missed-fires section = "ADR 0015") + README row, `docs/reference/`, changeset.

## TL;DR

A per-job flag `catchUp` (default `false`). At daemon start, for an enabled `catchUp` job with >=1 missed fire, run it once with `plannedAt` = the latest missed fire; record every other missed fire as `skipped`. Jobs without the flag behave exactly as today (`missed` rows, never executed). Runs only at daemon startup (the autostart-at-login moment, SP07-09), not on reload.

## Problem

- Missed fires are recorded, never run `[verified: daemon/index.ts:200-255; ADR 0001 "Missed fires are reported, never replayed"]`. A daily "morning report" job on a laptop that was off at 09:00 never runs.
- ADR 0001 already names this: "Users repeatedly ask for opt-in catch-up of the most recent missed fire" is its listed revisit trigger `[verified: 0001:195]`. Default-on was rejected (30s job down a month = 86,400 replays), hence opt-in + run-once.
- `docs/concepts/scheduling.md:56-58` still says "does not catch up" and "holds no persistent last-fired state", which is stale vs the watermark `[verified]`.

## Goals / Non-Goals

**Goals:** opt-in flag across client/CLI/MCP/API/dashboard/export; deterministic single run + `skipped` records; correct under the 500 cap, interval `startAt`, one-shot, overlap, retry, `after` dependents.
**Non-Goals:** replay-all; default-on; max-age window; sleep/wake catch-up while the daemon stays up; staggering; catch-up for `after`/`webhook` kinds.

## Requirements

| # | Requirement |
|---|---|
| R1 | `Job.catchUp: boolean`, zod `.default(false)`. Only valid when `isTimeSchedule(schedule)` (cron/interval/one-shot); `true` with `after`/`webhook` -> `INVALID_JOB` (create, update, kind change, import). |
| R2 | CLI `--catch-up` / `--no-catch-up` in `commonJobOptions` (new + update; undefined = unchanged on update). MCP `catchUp?: boolean` on create/update. API: plain job field on `POST/PUT /api/jobs`. |
| R3 | Display: `jobs get` prints `catch-up: on\|off`; `jobs list` schedule label gets a ` (catch-up)` suffix; dashboard row badge. Export/import carry the field unchanged. |
| R4 | Dashboard editor: checkbox "Catch up missed run on daemon start", shown only for kinds whose `SCHEDULE_KINDS` entry sets `supportsCatchUp: true`; hidden and cleared on other kinds. |
| R5 | Startup: for enabled `catchUp` jobs with missed fires, dispatch ONE normal run with `plannedAt` = latest missed fire; all other missed fires -> terminal `skipped`, `error: "CATCH_UP: superseded by catch-up run <runId>"`. |
| R6 | Cap: when capped, the latest fire is computed directly (`Scheduler.latestFireBefore`), not taken from the enumerated (earliest 500) list; the existing summary row becomes `skipped` with the same reason and honest wording. |
| R7 | `missedFireSummary` gains `catchUpRuns`; status API/`daemon status` show it. |
| R8 | Interval `startAt` honored in enumeration: no fires before `startAt`; fires on the `startAt` grid (matching live scheduler). Fixes `missed` accuracy too. |
| R9 | Docs/spec/ADR/changeset per Docs section. |

## Architecture

```
startup: loadJobs -> scheduler -> reconcile scan (per job)
   catchUp=false: recordMissedRun x N (unchanged)
   catchUp=true : fires -> latest L ; skipped x (N-1) ; pending.push({job, L, N})
-> runner created -> reconcileOrphanRuns/adopt -> tick + after listeners wired
-> for pending: dispatch(job, L)   // same path as a tick
```

- The scan keeps its place but collects `pending` instead of running; dispatch happens after `Runner`, orphan reconcile/adoption, and the `tick`/SP05 `after` listeners exist (runner is built after the scan today `[verified: index.ts:253]`, so an inline run is impossible).
- Extract the body of the `tick` listener (re-read job, `insertRun(jobId, plannedAt)`, `recordTick`, `runner.run`) into `dispatchTimeRun(jobId, plannedAt, ctx?)`; catch-up and ticks share it. Overlap (`skip|queue|cancel-previous`), retry, timeout, auto-disable-after-3-failures all apply unchanged because it is a normal `runner.run`. Adopted orphan + `overlap=skip` -> catch-up run is recorded `skipped` by the runner (acceptable, visible).
- Optional env via SP05 `RunContext`: `CRONTICK_TRIGGER=catch-up`, `CRONTICK_CATCHUP_MISSED=<N>`.
- `Store.recordSkippedRun(jobId, plannedAt, reason)` beside `recordMissedRun` (or one helper taking status). Retention prune treats both terminal `[verified: store.ts:22-25]`.
- Watermark: `recordTick(L)` via dispatch, then the scan's final `recordTick(now)` as today.

Edge cases:

| Case | Behavior |
|---|---|
| Reload (`daemon reload`) | No catch-up. Timers and watermark are live; reload only re-registers. |
| Restart / stop+start | Catch-up applies (a fire in the gap runs once). |
| Wake from sleep, daemon up | Out of scope. Timers are plain Node/croner timers `[verified: scheduler.ts:194,239]`; behavior after suspend is unverified (see OPEN). |
| Disabled during downtime | Not caught up (scan `continue`s `[verified]`). Also advance watermark for disabled jobs at startup and on enable so re-enabling never back-fills a stale gap. |
| One-shot, `runAt` passed while down | Catch-up runs it (1 fire). Without flag: `missed` as today. One-shot with no watermark: seeded, not run (unchanged, R-004-29). |
| No watermark | Seeded with now, no catch-up (R-004-29 unchanged). |
| Interval with `startAt` | R8. Future `startAt`: zero fires. |
| `after` dependents | A catch-up run is a normal run; `recordRunOutcome` fires dependents (listener wired before dispatch). |

## Decisions

| # | Decision | Alternatives | Why |
|---|---|---|---|
| D1 | Job-level `catchUp`, not inside `schedule` | Per-kind field in schedule union | One field, one validator, one editor control; schedule kinds `after`/`webhook` (SP05/06) have no fires. Rejection on non-time kinds keeps it honest |
| D2 | Run the **latest** missed fire | Earliest; any | Stale earlier fires are superseded; matches "what should have run most recently" |
| D3 | Others `skipped`, not `missed` (owner) | Keep `missed` | `skipped` + reason says "intentionally not run"; `missed` stays "no one was there and nothing ran" |
| D4 | Startup only, not reload | Also on reload/wake | Reload never has a gap; wake is a different mechanism, deferred |
| D5 | Dependents fire normally | Suppress | Catch-up is a real execution; suppressing leaves chains stale |
| D6 | One-shot is caught up | Keep missed | A one-shot that never runs is the worst failure mode of downtime |
| D7 | Reject on non-time kinds | Silently ignore | No dead flags |
| D8 | Fix interval `startAt` enumeration here | Leave | Catch-up would otherwise run a fire that never existed |

## Risks / Open Questions

- [OPEN] Sleep/wake: does croner/`setTimeout` fire once late, skip, or drift after suspend (Linux monotonic clock excludes suspend)? Cheapest test: manual `rtcwake`/VM suspend with a 1-minute cron job. Outcome may justify a follow-up, not SP10.
- [DEFERRED] Login storm: many `catchUp` jobs start simultaneously at autostart. No global concurrency cap exists `[unverified]`. Stagger / concurrency cap deferred (owner decision).
- [DEFERRED] Prompt staleness: a fire days old still runs. Max-age option deferred to `futures.md` (see 'Catch-up max-age'); prompt authors can read `CRONTICK_CATCHUP_MISSED`.
- [OPEN] Does enable/`recordTick` change belong here or SP05's enable guard path (shared `api.ts` enable route)? Coordinate at coding.
- [RESOLVED: SP05 is a hard dependency (C7)] SP10 needs SP05's `RunContext` env and `isTimeSchedule`. Two dispatch functions stay: SP05 `TriggerDispatcher.dispatch` (no `recordTick`) vs SP10 `dispatchTimeRun` (with `recordTick`), because the watermark is time-only.
- [RESOLVED: ADR "0015"] No standalone file; it is a section in `0001-architecture-and-runtime-model.md` with an index row mapping 0015 -> 0001. Amend in place and move its "revisit when" bullet to "revisited by SP10".

## Acceptance Criteria

- Fake-timer/unit: flag off -> N `missed` rows, no run (regression). Flag on, N=1 -> one run, no skipped. N=5 -> one run (`plannedAt` = 5th), four `skipped` with reason.
- Capped (>500): run `plannedAt` = true latest fire; summary row `skipped`; `catchUpRuns=1`.
- Interval `startAt` future -> nothing; past -> fires on startAt grid.
- One-shot past `runAt` runs once; disabled job untouched and watermark not stale on enable.
- Overlap `skip` with adopted live run -> `skipped` run; `queue` queues; retry on failing catch-up run works; `after` dependent fires once.
- Reload does not catch up. `catchUp:true` + `after` kind rejected in create/update/import.
- `surface-drift`, CLI new/update option-sync, MCP schema, dashboard string test (checkbox, `supportsCatchUp`), docs/spec/ADR/changeset updated; `npm run validate` green.
