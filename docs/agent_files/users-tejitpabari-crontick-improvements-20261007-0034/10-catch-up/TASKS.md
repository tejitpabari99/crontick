---
status: draft
summary: Seven tasks - catchUp schema + time-only validation, interval startAt/latestFireBefore, store skipped + dispatchTimeRun, startup catch-up flow + summary, prepare/client/CLI/MCP/API/surface, display + dashboard, tests/docs/ADR/changeset.
date: 2026-10-08
---
# Tasks: SP10 Catch-up
Source of truth: docs/agent_files/users-tejitpabari-crontick-improvements-20261007-0034/10-catch-up/PRD.md. No [OPEN] items remain; two [DEFERRED: verify during implementation] items are mapped to Done-when steps (Task 4). Hard depends on SP05 (`isTimeSchedule`, `RunContext`/`buildRunEnv`, `TriggerDispatcher`, listener ordering); soft on SP04 (`job-prepare.ts`, `SCHEDULE_KINDS`) and SP01 (`commonJobOptions`). Login-storm cap and max-age are deferred with no task. No new runtime dependencies.

| # | Task | Depends on | Status |
|---|---|---|---|
| 1 | `catchUp` job field and time-only validation | - | todo |
| 2 | Interval `startAt` enumeration and `latestFireBefore` | - | todo |
| 3 | Store `recordSkippedRun` and `dispatchTimeRun` | - | todo |
| 4 | Startup catch-up flow, watermark, summary | 1, 2, 3 | todo |
| 5 | Prepare, client, CLI, MCP, API, `SURFACE_CAPABILITIES` | 1, 4 | todo |
| 6 | Display and dashboard editor | 1, 5 | todo |
| 7 | Tests, docs, ADR "0015" amendment, changeset | 1-6 | todo |

## Task 1 — `catchUp` job field and time-only validation
What it is / what it means: The data shape and the honesty rule that the flag only exists where fires exist (R1, D1, D7).
What changes at a high level: Add `catchUp` to the job schema as a boolean defaulting to false. Validate with SP05's `isTimeSchedule`: true on `after` or `webhook` schedules is `INVALID_JOB`, enforced on create, update, schedule-kind change and import. Existing stored jobs load unchanged.
Done when: Default false on old jobs; true accepted for cron, interval and one-shot; rejected for non-time kinds on every entry path including changing kind while the flag is on.

## Task 2 — Interval `startAt` enumeration and `latestFireBefore`
What it is / what it means: Make fire enumeration match the live scheduler and give catch-up a cap-safe way to find the latest fire (R6, R8, D8).
What changes at a high level: Fire enumeration for interval schedules honors `startAt`: no fires before it, fires on the `startAt` grid, a future `startAt` yields none. Add `Scheduler.latestFireBefore` computing the latest fire directly rather than from the earliest-500 list. This also corrects plain `missed` accuracy.
Done when: Fake-timer tests show future `startAt` gives zero fires, past `startAt` gives grid-aligned fires, and the latest fire is correct for counts above 500.

## Task 3 — Store `recordSkippedRun` and `dispatchTimeRun`
What it is / what it means: The two building blocks catch-up and ticks share (Architecture, D3, D5).
What changes at a high level: `Store.recordSkippedRun(jobId, plannedAt, reason)` beside `recordMissedRun` (or one helper taking a status); retention prune treats both as terminal. Extract the tick listener body (re-read job, insert run, `recordTick`, `runner.run`) into `dispatchTimeRun(jobId, plannedAt, ctx?)` so ticks and catch-up share it. SP05's `TriggerDispatcher.dispatch` stays separate, without `recordTick`, because the watermark is time-only.
Done when: Tick behavior is unchanged under existing tests; skipped rows carry the reason and are pruned like missed; overlap, retry, timeout and auto-disable apply as for any normal run.

## Task 4 — Startup catch-up flow, watermark, summary
What it is / what it means: The core behavior (R5, R6, R7, D2, D3, D4, D5, D6).
What changes at a high level: In the startup scan, `catchUp=false` jobs keep `missed` rows. For enabled `catchUp` jobs, record all but the latest missed fire as `skipped` with reason "CATCH_UP: superseded by catch-up run <runId>" and collect a pending entry. When capped, take the latest from `latestFireBefore` and make the summary row `skipped` with honest wording. After the runner, orphan reconcile and the `tick` and `after` listeners exist, dispatch each pending entry via `dispatchTimeRun`, with env `CRONTICK_TRIGGER=catch-up` and `CRONTICK_CATCHUP_MISSED` via `RunContext`. One-shots with a passed `runAt` run; no-watermark jobs are seeded only. Advance the watermark for disabled jobs at startup and on enable. Reload never catches up. `missedFireSummary` gains `catchUpRuns`, shown by status and `daemon status`.
Done when: N=1 gives one run, N=5 gives one run plus four skipped, cap case runs the true latest, `after` dependents fire once, adopted orphan with `overlap=skip` yields a visible skipped run. DEFERRED verify (enable/`recordTick` ownership): confirm with SP05's enable guard on the shared enable route which task owns the watermark change; fallback is a single shared call site. DEFERRED verify (sleep/wake): manual suspend test with a 1-minute cron job to see whether timers fire late, skip or drift; the outcome may justify a follow-up and is not SP10 scope.

## Task 5 — Prepare, client, CLI, MCP, API, `SURFACE_CAPABILITIES`
What it is / what it means: Surface parity for the flag (R2).
What changes at a high level: `--catch-up` / `--no-catch-up` in `commonJobOptions` for new and update, undefined meaning unchanged on update. MCP `catchUp` on create and update; API carries it as a plain job field on `POST` and `PUT /api/jobs`. Thread through `job-prepare.ts` and `job-input.ts`; update `SURFACE_CAPABILITIES` and MCP descriptions. Shims stay thin.
Done when: Flag round-trips on all surfaces; update without the flag leaves it unchanged; non-time kinds produce `INVALID_JOB`; `surface-drift` and CLI option-sync tests are green.

## Task 6 — Display and dashboard editor
What it is / what it means: Make the flag visible and editable (R3, R4).
What changes at a high level: `jobs get` prints `catch-up: on|off`; `jobs list` schedule label gets a " (catch-up)" suffix; dashboard row badge. Export and import carry the field unchanged. The dashboard editor shows the checkbox "Catch up missed run on daemon start" only for kinds whose `SCHEDULE_KINDS` entry sets `supportsCatchUp: true`; it is hidden and cleared on other kinds.
Done when: All display sites show the state; dashboard string test covers the checkbox and `supportsCatchUp`; export then import preserves the value.

## Task 7 — Tests, docs, ADR "0015" amendment, changeset
What it is / what it means: Close out per AGENTS.md and the PRD acceptance criteria (R9).
What changes at a high level: Fill gaps with fake timers: flag-off regression, N=1/5, cap, interval `startAt`, one-shot, disabled job, overlap policies, retry, reload, import rejection. Update `docs/concepts/scheduling.md` (replacing the stale "does not catch up" text), `docs/specs/{003,004,006}`, `docs/reference/`, and amend the missed-fires section of ADR 0001 (the "0015" section) after SP07 edits it, moving its revisit bullet to "revisited by SP10"; update the README index row. Add a changeset. Run `npm run validate`.
Done when: `npm run validate` is green and docs, specs, ADR and changeset reflect the shipped behavior.

## Closing note
No human-only manual steps beyond the maintainer-run suspend/wake test noted in Task 4.
