# Scheduling

After reading this page you will understand how crontick determines when to run jobs, how timezones apply, and what happens when the daemon is unavailable at a scheduled time.

## Schedule kinds

Every job has exactly one schedule, discriminated by `kind`:

| Kind | Fields | Behavior |
|------|--------|----------|
| `cron` | `cron`, `tz?` | Fires at times matching a cron expression |
| `interval` | `everySec`, `startAt?` | Fires repeatedly at a fixed interval |
| `one-shot` | `runAt` | Fires once at a specific ISO-8601 timestamp |

## Cron expressions

crontick uses **croner** v9 for cron parsing. Croner supports 5-field (minute-level) and 6-field (second-level) expressions. The field order from left to right:

- 6 fields: `second minute hour day month weekday`
- 5 fields: `minute hour day month weekday`

Standard cron features (ranges, steps, lists, `L`, `W`, `#`) are supported as defined by croner. Validation is performed at job creation time via `new Cron(pattern, { paused: true })`.

## Timezone handling

The optional `tz` field on a `cron` schedule is passed directly to croner as `CronOptions.timezone`. When omitted, the daemon's local system timezone applies. There is no global timezone setting; each job owns its own.

Interval and one-shot schedules use UTC timestamps (ISO-8601 strings) and are timezone-agnostic.

## Interval alignment

For `interval` schedules, the initial delay depends on `startAt`:

- **No startAt**: the first tick fires after one full `everySec` interval.
- **startAt in the future**: the first tick fires at `startAt`, then every `everySec` thereafter.
- **startAt in the past**: the scheduler calculates `elapsed % intervalMs` to align the next tick to the original cadence.

## One-shot scheduling

A `one-shot` schedule fires at `runAt` and then the entry is removed from the scheduler's internal map. If `runAt` is already in the past when the job is registered, the scheduler silently skips it (no retroactive firing).

## Safe timeout chaining

JavaScript `setTimeout` clamps delays greater than 2^31-1 ms (~24.8 days) to 1 ms. The scheduler uses a `safeSetTimeout` helper that chains intermediate 2,000,000,000 ms timeouts for long-lived interval and one-shot schedules.

## Next-run preview and validation

The `Scheduler.previewNext()` method returns up to `n` future fire times for any schedule without actually registering a timer. `Scheduler.validateSchedule()` checks structural validity (parseable cron, positive interval, valid ISO date).

Both are exposed through the CLI (`schedule preview`, `schedule validate`) and MCP tools.

## Missed runs when the daemon is down

crontick does **not** catch up on missed ticks. If the daemon was stopped while a cron tick should have fired, that tick is lost. When the daemon restarts it re-registers all enabled jobs from the current moment forward. The scheduler holds no persistent "last fired at" state.

## Overlap policy when a previous run is still active

When the scheduler emits a tick but the job's previous run has not finished:

| `overlap` | Behavior |
|-----------|----------|
| `skip` | New run is immediately finalized as `canceled` with error `overlap=skip: another run is already active` |
| `queue` | New run is placed in a per-job FIFO queue and executed after the active run completes |
| `cancel-previous` | The active run's abort controller is triggered, and the new run starts |

See [Execution](./execution.md) for how the Runner enforces these policies.

## Further reading

- [Jobs](./jobs.md) - job model and action kinds
- [Daemon lifecycle](./daemon-lifecycle.md) - when the scheduler is active
- [CLI reference](../reference/cli.md) - `schedule validate` and `schedule preview` commands
