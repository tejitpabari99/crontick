# Scheduling

Audience: users and contributors reasoning about when jobs fire. Non-duplication: for the
normative contract see [specs/002-scheduling.md](../specs/002-scheduling.md); for the timer
implementation see [implementation/scheduler.md](../implementation/scheduler.md).

After reading this page you will understand how crontick determines when to run jobs, how timezones apply, and what happens when the daemon is unavailable at a scheduled time.

## Schedule kinds

Every job has exactly one schedule, discriminated by `kind`:

| Kind | Fields | Behavior |
|------|--------|----------|
| `cron` | `cron` | Fires at times matching a cron expression |
| `interval` | `everySec`, `startAt?` | Fires repeatedly at a fixed interval |
| `one-shot` | `runAt` | Fires once at a specific ISO-8601 timestamp |
| `after` | `jobId`, `status` | Fires when another (upstream) job's run finishes; not time-based (see [After triggers](#after-triggers)) |
| `webhook` | `relay?`, `secret?` | Fires on an event from an outbound relay or `jobs trigger`; not time-based (see [Webhook triggers](#webhook-triggers)) |

## Cron expressions

crontick uses **croner** v9 for cron parsing. Croner supports 5-field (minute-level) and 6-field (second-level) expressions. The field order from left to right:

- 6 fields: `second minute hour day month weekday`
- 5 fields: `minute hour day month weekday`

Standard cron features (ranges, steps, lists, `L`, `W`, `#`) are supported as defined by croner. Validation is performed at job creation time via `new Cron(pattern, { paused: true })`.

## Timezone handling

Cron expressions always fire in the machine's local timezone (the daemon's system timezone). There is no per-job `tz` field or `--tz` flag; new input containing `tz` is rejected, and a `tz` in an already-stored job file is silently ignored.

Interval schedules are timezone-agnostic. A one-shot `runAt` is an ISO-8601 string parsed with JavaScript `Date`: with an explicit offset (`Z`, `+02:00`) it is that exact instant; a date-time without an offset (`2026-10-01T09:00`) is interpreted in the machine's local timezone; a date-only value (`2026-10-01`) is UTC midnight. A job has exactly one schedule (`cron`, `interval`, or `one-shot`); the CLI rejects combining `--cron`, `--every`, and `--at`.

## Interval alignment

For `interval` schedules, the initial delay depends on `startAt`:

- **No startAt**: the first tick fires after one full `everySec` interval.
- **startAt in the future**: the first tick fires at `startAt`, then every `everySec` thereafter.
- **startAt in the past**: the scheduler calculates `elapsed % intervalMs` to align the next tick to the original cadence.
- Missed-fire enumeration uses the same `startAt` grid: no fire is ever computed before `startAt`, and a future `startAt` yields zero missed fires.

## One-shot scheduling

A `one-shot` schedule fires at `runAt` and then the entry is removed from the scheduler's internal map. If `runAt` is already in the past when the job is registered, the scheduler silently skips it (no retroactive firing).

## Safe timeout chaining

JavaScript `setTimeout` clamps delays greater than 2^31-1 ms (~24.8 days) to 1 ms. The scheduler uses a `safeSetTimeout` helper that chains intermediate 2,000,000,000 ms timeouts for long-lived interval and one-shot schedules.

## Next-run preview and validation

The `Scheduler.previewNext()` method returns up to `n` future fire times for any schedule without actually registering a timer. `Scheduler.validateSchedule()` checks structural validity (parseable cron, positive interval, valid ISO date).

Previews are exposed for an existing job as `crontick jobs schedule <id|alias>` and the `crontick_job_schedule` MCP tool. Raw schedule validation/preview (`validateSchedule`/`previewSchedule`) is library-only.

## Missed runs when the daemon is down

By default crontick does **not** run fires that came due while the daemon was stopped. The daemon keeps a persistent per-job "last seen ticking" watermark (`job_schedule_state`). On startup it enumerates the fires each enabled job should have had since that watermark (capped at 500 per job) and records each as a terminal `missed` run; nothing is executed. A job with no watermark is seeded with the current time and no gap is computed. See [daemon lifecycle](daemon-lifecycle.md#what-happens-while-the-daemon-is-down).

## Catch-up (opt-in)

A job with `catchUp: true` (default `false`; valid only on `cron`, `interval` and `one-shot`, otherwise `VALIDATION_ERROR`) runs its **latest** missed fire once when the daemon starts:

- The run's `plannedAt` is the latest missed fire. It is a normal run: overlap policy, retry, timeout and auto-disable apply, and `after` dependents fire once when it finishes.
- Every other missed fire is recorded as `skipped` with `error: "CATCH_UP: superseded by catch-up run <runId>"`. `missed` keeps meaning "nothing ran and nobody decided that".
- Beyond the 500 cap the latest fire is computed directly (`Scheduler.latestFireBefore`), so the run still uses the true latest fire; one summary row is recorded as `skipped` instead of 500 rows.
- The run gets `CRONTICK_TRIGGER=catch-up` and `CRONTICK_CATCHUP_MISSED=<n>` (a lower bound when capped), so a prompt can tell it is late.
- A `one-shot` whose `runAt` passed while the daemon was down runs. Without the flag it is recorded `missed`.
- Jobs with no watermark are only seeded. Disabled jobs are never caught up, and their watermark advances at startup, so re-enabling never back-fills a stale gap.
- With `overlap: skip` and an adopted run from the previous daemon still alive, the catch-up run is recorded as a visible `skipped` run.
- Only daemon **startup** catches up. `daemon reload` never does, and neither does a machine waking from sleep while the daemon stays up (timers after suspend are unverified pending a manual suspend test).
- `missedFires.catchUpRuns` (in `daemon status` / `GET /api/daemon/status`) counts catch-up runs started at that startup.

Set it with `--catch-up` / `--no-catch-up` on `jobs new|update`, `catchUp` in MCP create/update and the library, or the dashboard checkbox "Catch up missed run on daemon start". `jobs get` prints `catch-up: on|off`, `jobs list` appends ` (catch-up)`. Export and import carry the field. Rationale: [ADR 0001](../decisions/0001-architecture-and-runtime-model.md) ("Missed fires are reported; opt-in catch-up runs only the latest").

## After triggers

`{ kind: 'after', jobId, status }` runs a job when its **upstream** job finishes a run (`crontick jobs new --after <id|alias> --after-status success|failure|any`; default `success`). `jobId` is always the upstream GUID: an alias given on input is resolved before storage, so renaming the upstream alias keeps the dependent firing.

- **What triggers.** Any terminal run of the upstream, whatever started it (schedule, `run-now`), after its retries are exhausted. `success` fires on `success`; `failure` on `failed` or `timeout`; `any` on either. `canceled`, `skipped` and `missed` never trigger. The run that auto-disables the upstream still triggers `failure`/`any` dependents, and manual runs of a disabled upstream trigger too.
- **Exactly once.** One dispatch per terminal upstream run, adopted runs included. A disabled downstream is silently not run (no run row).
- **Chains.** A downstream's own completion triggers its dependents, so A -> B -> C works. Cycles (including self) are rejected with `AFTER_CYCLE`; a missing upstream with `AFTER_UPSTREAM_NOT_FOUND` (create, update, enable). On import a dangling upstream imports the job disabled with that error recorded; a cycle is rejected. A job file edited by hand into a dangling or cyclic graph is loaded but inert (warning logged, labelled `(missing)` in `jobs list` when the upstream is gone, flagged by `crontick doctor`); it starts firing again as soon as the graph is repaired.
- **Environment.** The downstream run gets `CRONTICK_TRIGGER=after`, `CRONTICK_UPSTREAM_RUN_ID`, `CRONTICK_UPSTREAM_STATUS` (`success|failed|timeout`), `CRONTICK_UPSTREAM_JOB_ID` and `CRONTICK_UPSTREAM_JOB_ALIAS` (omitted when the upstream has no alias). These override `action.env`. Fetch upstream output with `crontick runs get "$CRONTICK_UPSTREAM_RUN_ID"`.
- **No replay.** Completions that happen while the daemon is down, and runs finalized during startup reconciliation, trigger nothing (same stance as missed runs). A chain interrupted by downtime stops; the next upstream run resumes it. An adopted run that exits after the restart does trigger.
- **No next-run time.** After jobs show `after <alias> (on success)` instead of a time; previews are empty.
- **Deleting an upstream.** `jobs delete` refuses with `JOB_HAS_DEPENDENTS` (listing aliases) unless `--force`, which disables the dependents; they keep the dangling reference until re-pointed.

**Fast upstream, slow downstream.** The downstream's own `overlap` policy applies to each trigger. With the default `skip`, a trigger that arrives while the downstream is still running is dropped and recorded as a `skipped` run. If every upstream completion must be handled, set the downstream to `overlap: queue`; `cancel-previous` keeps only the newest.

## Webhook triggers

`{ kind: 'webhook', relay?, secret? }` (`crontick jobs new --webhook [--relay <url|auto>] [--webhook-secret <s>]`) runs a job per event. The daemon holds one outbound SSE connection per distinct relay URL; `crontick jobs trigger <job>` fires it locally. Like `after`, it is not time-based: no next-run time, no tick, nothing reported as missed, and events that arrive while the daemon is down are lost (no replay). Triggered runs get `CRONTICK_TRIGGER=webhook`, `CRONTICK_EVENT`, `CRONTICK_EVENT_SOURCE` and `CRONTICK_EVENT_ID`, the payload is appended to the prompt as fenced untrusted data, and the normal overlap, retry and timeout policy applies (relay events are additionally HMAC-checked, deduplicated and limited to 10 runs/minute). Full guide, GitHub setup and security: [Webhooks](webhooks.md).

## Overlap policy when a previous run is still active

When the scheduler emits a tick but the job's previous run has not finished:

| `overlap` | Behavior |
|-----------|----------|
| `skip` | New run is immediately finalized as `skipped` with error `overlap=skip: another run is already active`; no process starts |
| `queue` | New run is placed in a per-job FIFO queue and executed after the active run completes |
| `cancel-previous` | The active run's abort controller is triggered, and the new run starts |

See [Execution](./execution.md) for how the Runner enforces these policies.

## Further reading

- [Jobs](./jobs.md) - job model and action kinds
- [Daemon lifecycle](./daemon-lifecycle.md) - when the scheduler is active
- [CLI reference](../reference/cli.md) - `jobs schedule` command
