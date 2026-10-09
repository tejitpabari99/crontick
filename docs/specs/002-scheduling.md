# 002: Scheduling

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-07-25

Audience: contributors changing the scheduler or schedule validation. Non-duplication: this
spec is the normative contract; for the mental model see
[concepts/scheduling.md](../concepts/scheduling.md), and for implementation detail see
[implementation/scheduler.md](../implementation/scheduler.md).

## Summary

Crontick supports three schedule kinds: `cron` (recurring via cron expression),
`interval` (recurring every N seconds), and `one-shot` (fire once at a specific time).
The scheduler registers timers and emits `tick` events consumed by the runner.

## Motivation

Supporting multiple schedule kinds lets users express both traditional cron patterns and
simpler periodic/one-time tasks without external tooling. Timezone support ensures
correct behavior across regions.

## Terminology

| Term | Definition |
|------|-----------|
| Tick | An event emitted when a scheduled time arrives; triggers a run. |
| Cron expression | A string parsed by `croner` v9 (5 or 6 fields, extended syntax). |
| Interval | A fixed period in seconds between ticks. |
| One-shot | A single future ISO-8601 timestamp; fires once, then the entry is removed. |

## Requirements

### Functional requirements

- **R-002-1**: The `schedule.kind` discriminator MUST be one of `cron`, `interval`, `one-shot`, `after`, `webhook`.
- **R-002-2**: A `cron` schedule MUST have a non-empty `cron` string and MUST NOT have a `tz` field: cron expressions fire in the machine local timezone. (New input containing `tz` is rejected with `VALIDATION_ERROR`; a `tz` in an already-stored job file is silently ignored: no warning, log or event.)
- **R-002-3**: An `interval` schedule MUST have a positive `everySec` number and MAY have a `startAt` ISO-8601 string.
- **R-002-4**: A `one-shot` schedule MUST have a non-empty `runAt` ISO-8601 string. A date-time without an offset is interpreted in the machine's local timezone.
- **R-002-4a**: A job MUST have exactly one schedule; supplying more than one of `--cron`, `--every`, `--at` MUST be rejected with `VALIDATION_ERROR`, and none with `MISSING_ARG`.
- **R-002-5**: The scheduler MUST create cron entries without a timezone option so croner evaluates them in the machine local timezone.
- **R-002-6**: The scheduler MUST NOT schedule a disabled job (enabled=false); calling `schedule()` on a disabled job MUST be a no-op.
- **R-002-7**: `schedule()` MUST be idempotent; calling it on an already-scheduled job MUST first unschedule the previous entry.
- **R-002-8**: A one-shot whose `runAt` is in the past MUST NOT fire; the entry MUST NOT be registered.
- **R-002-9**: After a one-shot fires, the scheduler MUST remove the entry from its internal map.
- **R-002-10**: For intervals with `startAt` in the future, the first tick MUST fire at `startAt`, then every `everySec` thereafter.
- **R-002-11**: For intervals with `startAt` in the past, the first tick MUST fire at the next aligned boundary: `now + (everySec - ((now - startAt) % everySec))`.
- **R-002-12**: For intervals without `startAt`, the first tick MUST fire after `everySec` seconds from scheduling time.
- **R-002-13**: `validateSchedule()` MUST return `{ ok: true }` for a valid schedule or `{ ok: false, error: string }` for an invalid one.
- **R-002-14**: `previewNext()` MUST return up to N ISO-8601 timestamps representing the next N scheduled fires.
- **R-002-15**: `setTimeout` delays exceeding 2^31-1 ms MUST be handled via chained intermediate timeouts (`safeSetTimeout`).
- **R-002-16**: An `after` schedule is `{ kind: 'after', jobId, status }` with `jobId` an upstream GUID (aliases are resolved to the GUID before storage) and `status` one of `success`, `failure`, `any` (CLI default `success`). `Scheduler.schedule` MUST no-op for it; `previewNext` and `enumerateFiresBetween` MUST return `[]`; `validateSchedule` MUST return ok; the startup missed-fire loop MUST skip it.
- **R-002-17**: Every terminal run (after retries, adopted runs included, any origin) MUST be offered once to the run-completion hook. A dependent enabled job fires iff the status matches: `success` on `success`; `failure` on `failed`/`timeout`; `any` on either. `canceled`, `skipped` and `missed` MUST NOT trigger. The dispatch goes through the normal runner, so the downstream `overlap`, retry and timeout apply (`skip` records a visible `skipped` run).
- **R-002-18**: Completions while the daemon was down and runs finalized during startup reconciliation MUST NOT trigger dependents (no replay). Adopted runs that exit after startup MUST.
- **R-002-19**: A triggered run MUST receive `CRONTICK_TRIGGER=after`, `CRONTICK_UPSTREAM_RUN_ID`, `CRONTICK_UPSTREAM_STATUS`, `CRONTICK_UPSTREAM_JOB_ID` and (when the upstream has an alias) `CRONTICK_UPSTREAM_JOB_ALIAS`, with priority above `action.env`; the run's `trigger_json` MUST record `{ kind: 'after', upstream: <run id> }`. The time-only watermark (`recordTick`) MUST NOT advance.
- **R-002-20**: Cycles (including self) MUST be rejected with `AFTER_CYCLE` on create, update, enable and import; a missing upstream with `AFTER_UPSTREAM_NOT_FOUND` on create, update and enable. On import a dangling upstream MUST import the job disabled with `AFTER_UPSTREAM_NOT_FOUND` recorded and the rest of the batch proceeds. On reload, dangling or cyclic after-jobs MUST be loaded but inert and flagged broken.
- **R-002-21**: Deleting a job that other jobs run `after` MUST fail with `JOB_HAS_DEPENDENTS` unless `force`; `force` disables the dependents.
- **R-002-22**: A `webhook` schedule is `{ kind: 'webhook', relay?, secret? }`; `relay` is an https URL (http only for loopback hosts), exclusive with every other kind. `Scheduler.schedule` MUST no-op for it, previews are empty and no missed fire is ever enumerated. `--relay`/`--webhook-secret` without `--webhook` MUST be rejected.
- **R-002-23**: The daemon MUST open one outbound SSE connection per distinct relay URL of enabled webhook jobs, shared by refcount, and none otherwise; it MUST NOT add an inbound listener. Reconnect backoff is 1s to 60s with jitter; 90s without data aborts and reconnects; no events are processed after stop; events lost while disconnected are never replayed.
- **R-002-24**: A relay event MUST pass, in order, HMAC (when `secret` is set: `x-hub-signature-256` over `JSON.stringify(body)`, constant-time compare), dedupe (per job, 256 entries / 10 minutes, keyed delivery id, else `x-request-id`, else body hash) and a 10 per minute per-job burst limit (drops recorded as one `skipped` run per minute with `RATE_LIMITED (n dropped)`). Local triggers MUST skip all three.
- **R-002-25**: A triggered run MUST receive `CRONTICK_TRIGGER=webhook`, `CRONTICK_EVENT` (capped at 64KB with a truncation marker), `CRONTICK_EVENT_SOURCE=relay|local` and, when known, `CRONTICK_EVENT_ID`, above `action.env`; the prompt MUST get the untrusted-data preamble and the payload in a fence longer than any backtick run in it. Relay payload headers MUST be allowlisted.
- **R-002-26**: `jobs trigger`, `crontick_job_trigger`, `triggerJob` and `POST /api/jobs/:id/trigger` MUST fire only enabled webhook jobs (`NOT_WEBHOOK_JOB`, `JOB_DISABLED`) and reject non-JSON payloads (`INVALID_PAYLOAD`). Relay URLs and secrets MUST be redacted except in `jobs get`, `GET /api/jobs/:id`, the create response and the dashboard Copy.

### Non-functional requirements

- **R-002-16**: The scheduler SHOULD NOT accumulate memory for completed one-shot entries.
- **R-002-17**: Preview for cron schedules SHOULD return results without blocking the event loop.

## Behavior

**Cron**: A `Cron` instance from `croner` is created with the pattern and no timezone option (machine local time).
On each cron match, the callback emits a `tick` event with `plannedAt = new Date()`.

**Interval**: An initial `safeSetTimeout` fires after the computed delay. On first fire,
`setInterval` is registered for subsequent ticks. Each tick emits `plannedAt = new Date()`.

**One-shot**: A single `safeSetTimeout` is registered for `runAt - now`. On fire, the tick
emits `plannedAt = new Date(runAt)` and the entry is deleted.

**Unschedule**: Calls the entry's `stop()` function (clears cron/interval/timeout) and
removes the entry from the internal map. `unscheduleAll()` iterates all entries.

## Inputs and outputs

**Input to `schedule()`**: A full `Job` object (uses `job.schedule` and `job.enabled`).
**Output**: No return value; side-effect is a registered timer that emits `tick` events.
**`previewNext()` input**: A `Schedule` object + optional `{ n }`.
**`previewNext()` output**: `string[]` of ISO-8601 timestamps.
**`validateSchedule()` input**: A `Schedule` object.
**`validateSchedule()` output**: `{ ok: boolean; error?: string }`.

## Edge cases and failure modes

- Invalid cron expression: `validateSchedule` returns `{ ok: false, error }`. `previewNext` returns `[]`.
- `everySec` <= 0: Rejected by Zod schema (`.positive()`).
- `startAt` is not valid ISO-8601: `validateSchedule` returns error; scheduling ignores the invalid value (uses default delay).
- `runAt` is not valid ISO-8601: `validateSchedule` returns error; scheduling does not register.
- Clock change / DST: Croner handles DST transitions; interval timers use monotonic delay (unaffected by wall-clock changes).
- Delay > 24.8 days (2^31-1 ms): Handled by `safeSetTimeout` chaining.
- `previewNext` for an already-past one-shot: Returns `[]`.

## Acceptance criteria

- [x] Cron scheduling fires ticks at correct times (test file: `tests/unit/scheduler.test.ts`)
- [x] Interval scheduling respects startAt alignment (test file: `tests/unit/scheduler.test.ts`)
- [x] One-shot fires exactly once and removes entry (test file: `tests/unit/scheduler.test.ts`)
- [x] Disabled jobs are not scheduled (test file: `tests/unit/scheduler.test.ts`)
- [x] Idempotent schedule() replaces previous entry (test file: `tests/unit/scheduler.test.ts`)
- [x] validateSchedule rejects invalid cron (test file: `tests/unit/scheduler.test.ts`)
- [x] previewNext returns correct ISO timestamps (test file: `tests/unit/scheduler.test.ts`)
- [x] safeSetTimeout chains for large delays (test file: `tests/unit/property.scheduler.test.ts`)
- [x] Property: arbitrary cron expressions produce sorted future dates (test file: `tests/unit/property.cron.test.ts`)
- [x] One-shot past-time no-op verified in integration context (test file: `tests/unit/integration.oneshot.test.ts`)
- [x] After triggers: status x filter table, retries, chains, env, no-replay (test file: `tests/unit/trigger-dispatcher.test.ts`)
- [x] After triggers: adopted run exit and downstream overlap `skip|queue|cancel-previous` (test file: `tests/unit/after-trigger-gaps.test.ts`)
- [x] After triggers: cycles, dangling, delete force, import (test files: `tests/unit/store-after.test.ts`, `tests/unit/api-after-guards.test.ts`)
- [x] Webhook schedule: schema, flags, `--relay auto`, no-tick/no-missed (test file: `tests/unit/webhook-schedule.test.ts`)
- [x] Webhook relay: SSE parser, connection sharing, backoff, idle watchdog, stop, stale events (test files: `tests/unit/sse.test.ts`, `tests/unit/relay.test.ts`)
- [x] Webhook guards: HMAC, dedupe, burst limit (test file: `tests/unit/relay-guard.test.ts`)
- [x] Webhook payload framing, truncation, env, allowlist (test file: `tests/unit/webhook-payload.test.ts`)
- [x] Webhook relay event to a real run, end to end (test file: `tests/unit/webhook-e2e-gaps.test.ts`)
- [x] Trigger surfaces and errors (test file: `tests/unit/webhook-trigger-surface.test.ts`); redaction and export (`tests/unit/webhook-redaction.test.ts`); status rendering (`tests/unit/webhook-status-render.test.ts`); dashboard (`tests/unit/dashboard-webhook.test.ts`)
- [x] A live daemon's real Scheduler auto-fires a cron/interval tick end-to-end into a run, with no manual `/run` trigger (test file: `tests/unit/integration.autofire.test.ts`)

## Out of scope

- Missed-run catch-up (crontick does not retroactively fire missed ticks after daemon downtime).
- Replay of webhook events missed while the daemon or relay is down; event filtering; provider-specific verifiers other than GitHub `x-hub-signature-256`; multiple relays per job.
- Replay of upstream completions missed during downtime; multiple upstreams or AND-joins; passing upstream output (use `crontick runs get "$CRONTICK_UPSTREAM_RUN_ID"`); delay/debounce.
- Persistent schedule state (schedules are re-registered from job definitions on daemon start).

## Open questions

None.

## Related

- [001-job-definition.md](001-job-definition.md)
- [003-execution.md](003-execution.md)
- `../reference/`
- `../concepts/`
