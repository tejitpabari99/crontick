# 0015: Report missed fires as records, never replay them

- Status: Accepted
- Date: 2026-07-26

## Context

crontick is demand-started (ADR 0003): the daemon only fires jobs while it is running.
Before this decision, a fire that occurred while the daemon was stopped (machine off,
asleep, user logged out, daemon crashed) left no trace at all -- the next `daemon status`
looked identical whether every scheduled fire had happened on time or the daemon had been
down for a week. Users had no way to discover that a job silently did not run without
independently reasoning about daemon uptime.

The daemon cannot make a stopped period not have happened. The question this decision
answers is what to do about a fire it can prove it missed once it starts back up.

## Decision

On daemon startup, after loading jobs and before scheduling future ticks, the daemon
records a per-job schedule watermark (`job_schedule_state.last_tick_at`, updated via
`Store.recordTick()` every live tick) and uses it to compute exactly which fires occurred
between the last known tick and now, via `Scheduler.enumerateFiresBetween()`. Each missed
fire becomes a terminal run row with `status = 'missed'`, `error =
MISSED_RUN_ERROR_MESSAGE`, and no `pid` (`Store.recordMissedRun()`) -- capped at
`MISSED_FIRE_CAP_PER_JOB = 500` per job to bound startup cost after a very long gap. The
summary is exposed as `missedFires: { jobsWithMissedFires, missedRunsRecorded, jobsCapped,
capPerJob }` in `GET /api/daemon/status` and `crontick daemon status`.

Missed fires are **reported, never replayed**. The daemon does not run the job's action for
a missed fire, queue a catch-up execution, or attempt to compress multiple missed fires
into one run. A `missed` run is a record that a fire was scheduled and did not happen --
nothing more.

## Alternatives considered

**Replay every missed fire on startup.** Rejected: for a job that was supposed to fire
every minute across a week-long gap, this would queue over ten thousand near-simultaneous
executions the moment the daemon starts, which is almost never what a user wants and could
itself take down the machine or the target system the job talks to. There is also no way
to know, in general, whether a stale scheduled action is still safe or meaningful to run
after the fact (a backup job for yesterday, a reminder for an hour that already passed).

**Replay only the single most recent missed fire ("catch up once").** Considered as a
middle ground. Rejected for v1.0.0: it silently picks a policy (run the newest, not the
oldest, not all of them) that will be wrong for some jobs and right for others, with no way
to express the difference per-job. Simpler to report every fire precisely and let the user
or the job's own idempotency handle catch-up if they want it, than to guess a one-size
policy and be wrong by default.

**No missed-fire tracking at all (status quo).** This was the previous behavior. Rejected
per the explicit product mandate for v1.0.0: a demand-started daemon with silent gaps is
indistinguishable from a broken one from the user's point of view; making the gap visible
is what makes the demand-started design (ADR 0003) trustworthy rather than merely
convenient.

## Consequences

**Easier:**

- A user can tell, from `daemon status` or `runs list --status missed`, exactly which
  scheduled fires did not happen and when, without reasoning about daemon uptime
  independently.
- The demand-started design (ADR 0003) becomes safe to rely on for jobs where "know if it
  didn't run" matters as much as "run it," without requiring an OS-level supervisor.

**Harder:**

- A very long gap (weeks, months) followed by a startup with a high-frequency job could
  still record up to 500 missed runs for that job, which itself consumes retention-cap
  headroom (ADR 0012) and could evict older real history sooner than it otherwise would.
- Users who *do* want a fire to actually happen after a gap (e.g. a daily backup that must
  run at least once per day) get no built-in catch-up; they must build that into the job
  definition or a wrapper script themselves.

**Impossible:**

- Automatic replay/catch-up execution of a missed fire. This is a deliberate, permanent
  design boundary for v1.0.0, not a temporary gap -- see Revisit when.

## Revisit when

- Users repeatedly request an opt-in per-job "catch up the most recent missed fire on
  startup" policy with clear, bounded semantics (e.g. "at most one catch-up run, only if
  the gap is under N hours"). This would be an additive, explicitly opt-in job-level field,
  never a default, given the ambiguity documented above.
