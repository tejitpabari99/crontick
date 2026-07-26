# Scheduler

Implements: `src/daemon/scheduler.ts`

The `Scheduler` class manages timer registrations for all active jobs. It emits
`'tick'` events that the daemon wires to the runner. It also provides schedule
validation and next-fire-time preview.

---

## Class Design

`Scheduler` extends `EventEmitter`. It holds a `Map<string, { stop: () => void }>`
keyed by job ID. Each entry wraps a croner `Cron` instance, a `setInterval`, or
a `setTimeout` depending on the schedule kind.

```ts
// src/daemon/scheduler.ts
class Scheduler extends EventEmitter {
  private entries: Map<string, { stop: () => void }>;
  schedule(job: Job): void;
  unschedule(jobId: string): void;
  unscheduleAll(): void;
  previewNext(schedule: Schedule, opts?: PreviewOptions): string[];
  validateSchedule(schedule: Schedule): ValidateResult;
  enumerateFiresBetween(schedule: Schedule, fromExclusiveMs: number, toExclusiveMs: number, opts?: { cap?: number }): { fires: number[]; capped: boolean };
}
```

---

## Scheduling by Kind

### Cron (`schedule.kind === 'cron'`)

Uses `croner` v9 `new Cron(pattern, options, callback)`:

- `CronOptions.timezone` is set when `schedule.tz` is present.
- Callback fires `this.fireTick(job.id, new Date())`.
- Stopping: `cron.stop()`.

### Interval (`schedule.kind === 'interval'`)

1. Compute initial delay:
   - No `startAt`: delay = `everySec * 1000`.
   - `startAt` in the future: delay = `startAt - now`.
   - `startAt` in the past: align to next interval boundary:
     `intervalMs - ((now - startMs) % intervalMs)`.
2. First fire via `safeSetTimeout(delay)`; on that first fire it switches to
   `setInterval(intervalMs)` for every subsequent tick.
3. **Stable disposer.** The `{ stop }` object stored in `entries` for this job
   never changes across the timeout→interval transition. Internally, a single
   `currentTimer` variable (reassigned from the timeout's clearer to the
   interval's clearer at the moment of the first fire) and a `disposed` flag
   are captured by one closure that is set into `entries` once, up front. This
   replaced an earlier version that re-registered a *new* `entries` object at
   the timeout→interval transition. The `disposed` flag exists specifically to
   fix a race: if `unschedule(job.id)` is called synchronously from inside the
   job's own first-tick listener (i.e., before `setInterval` has been armed),
   the pending `setInterval(...)` call is skipped instead of re-arming a timer
   for an already-unscheduled job.

### One-shot (`schedule.kind === 'one-shot'`)

- `delay = runAt - now`. If <= 0, not scheduled (past).
- Single `safeSetTimeout`. After firing, auto-removes from `entries`.

---

## Safe Timeout (`safeSetTimeout`)

`setTimeout` clamps delays > 2^31-1 ms (~24.8 days) to 1 ms, causing
far-future timers to fire immediately. `safeSetTimeout` chains intermediate
2,000,000,000 ms timeouts until the remaining delay is within the safe range.

```ts
const MAX_SAFE_TIMEOUT_MS = 2_000_000_000;

function safeSetTimeout(cb: () => void, ms: number): SafeTimer {
  if (ms <= MAX_SAFE_TIMEOUT_MS) {
    const t = setTimeout(cb, ms);
    return { clear: () => clearTimeout(t) };
  }
  let inner: SafeTimer | undefined;
  const t = setTimeout(() => {
    inner = safeSetTimeout(cb, ms - MAX_SAFE_TIMEOUT_MS);
  }, MAX_SAFE_TIMEOUT_MS);
  return { clear: () => { clearTimeout(t); inner?.clear(); } };
}
```

---

## Tick Event

```ts
interface TickEvent {
  jobId: string;
  plannedAt: Date;
}
```

Emitted on the `'tick'` event. The daemon listener in `src/daemon/index.ts`
reads the latest job from the store (in case it was updated since scheduling),
checks `job.enabled`, inserts a queued run, and calls `runner.run()`.

---

## Preview

`previewNext(schedule, opts)` computes the next N fire times without side
effects:

- **Cron**: creates a paused `Cron`, iterates `cron.nextRun(ref)` N times.
- **Interval**: simple arithmetic from `now`.
- **One-shot**: returns `[runAt]` if in the future, else empty.

Helper: `cronNextN(pattern, tz, n)` (local to the module).

---

## Validation

`validateSchedule(schedule)` returns `{ ok: boolean; error?: string }`:

- **Cron**: instantiates `new Cron(pattern, { paused: true })` in a try/catch.
- **Interval**: checks `everySec > 0` and optional `startAt` is valid ISO-8601.
- **One-shot**: checks `runAt` parses to a valid Date.

---

## Idempotent Re-schedule

`schedule(job)` always calls `unschedule(job.id)` first, making it safe to call
on every job update without leaking timers. Disabled jobs (`!job.enabled`) are
silently skipped after unschedule.

---

## Enumerating Past Fires (`enumerateFiresBetween`)

`enumerateFiresBetween(schedule, fromExclusiveMs, toExclusiveMs, { cap })` walks a schedule
forward from `fromExclusiveMs` (exclusive) and collects every fire time strictly before
`toExclusiveMs`, without registering any timer or side effect — the same static computation
`previewNext` uses, but bounded by a time window instead of a fire count. It stops early and
sets `capped: true` once it has collected `cap` fires (`DEFAULT_ENUMERATE_FIRES_CAP = 500`),
so a job whose schedule fired thousands of times while the daemon was down does not force an
unbounded loop.

This is used exactly once in the codebase: by the daemon's startup missed-fire pass, which calls
it with `fromExclusiveMs` = the job's `job_schedule_state.last_tick_at` watermark and
`toExclusiveMs` = "now", to compute exactly which fires happened while no daemon process was
running. See [daemon.md](./daemon.md#missed-fire-reporting) for the full startup sequence and
[storage.md](./storage.md#missed-fire-reporting) for how each fire becomes a `missed` run.

---

## Drift Handling

There is no explicit drift correction. Croner handles cron drift internally.
Interval jobs may accumulate drift from Node.js event-loop delays (standard
`setInterval` behavior). One-shot and recurring jobs alike are not retried if the daemon was
down at a scheduled fire time — that fire is never executed after the fact. It is, however,
never silently lost: the daemon's startup missed-fire pass (built on
`enumerateFiresBetween` above) records it as a `missed` run, so the gap is always visible in
`crontick runs list` and in `daemon status`'s `missedFires` summary, even though nothing runs to
fill it. See [ADR 0015](../decisions/0015-report-missed-fires-not-replay.md) for why replay was
rejected in favor of reporting.
