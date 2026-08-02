# 002: Scheduling

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-07-25

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

- **R-002-1**: The `schedule.kind` discriminator MUST be one of `cron`, `interval`, `one-shot`.
- **R-002-2**: A `cron` schedule MUST have a non-empty `cron` string and MAY have a `tz` string.
- **R-002-3**: An `interval` schedule MUST have a positive `everySec` number and MAY have a `startAt` ISO-8601 string.
- **R-002-4**: A `one-shot` schedule MUST have a non-empty `runAt` ISO-8601 string.
- **R-002-5**: When `tz` is provided for a `cron` schedule, the scheduler MUST pass it to croner as `CronOptions.timezone`.
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

### Non-functional requirements

- **R-002-16**: The scheduler SHOULD NOT accumulate memory for completed one-shot entries.
- **R-002-17**: Preview for cron schedules SHOULD return results without blocking the event loop.

## Behavior

**Cron**: A `Cron` instance from `croner` is created with the pattern and optional timezone.
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
**`previewNext()` input**: A `Schedule` object + optional `{ n, tz }`.
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

- [x] Cron scheduling fires ticks at correct times (test file: `tests/scheduler.test.ts`)
- [x] Interval scheduling respects startAt alignment (test file: `tests/scheduler.test.ts`)
- [x] One-shot fires exactly once and removes entry (test file: `tests/scheduler.test.ts`)
- [x] Disabled jobs are not scheduled (test file: `tests/scheduler.test.ts`)
- [x] Idempotent schedule() replaces previous entry (test file: `tests/scheduler.test.ts`)
- [x] validateSchedule rejects invalid cron (test file: `tests/scheduler.test.ts`)
- [x] previewNext returns correct ISO timestamps (test file: `tests/scheduler.test.ts`)
- [x] safeSetTimeout chains for large delays (test file: `tests/property.scheduler.test.ts`)
- [x] Property: arbitrary cron expressions produce sorted future dates (test file: `tests/property.cron.test.ts`)
- [x] One-shot past-time no-op verified in integration context (test file: `tests/integration.oneshot.test.ts`)
- [x] A live daemon's real Scheduler auto-fires a cron/interval tick end-to-end into a run, with no manual `/run` trigger (test file: `tests/integration.autofire.test.ts`)

## Out of scope

- Missed-run catch-up (crontick does not retroactively fire missed ticks after daemon downtime).
- Persistent schedule state (schedules are re-registered from job definitions on daemon start).

## Open questions

None.

## Related

- [001-job-definition.md](001-job-definition.md)
- [003-execution.md](003-execution.md)
- `../reference/`
- `../concepts/`
