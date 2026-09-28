# 0029: Distinguish overlap skips and protect reused sessions

- Status: Accepted
- Date: 2026-09-28

## Context

An `overlap: "skip"` fire never starts a process, but crontick recorded it as `canceled`. That obscured the difference between a discarded fire and a run terminated after starting. A job reusing an engine session could also choose `queue` or `cancel-previous`, allowing concurrent or interrupted turns on that session.

## Decision

Record every overlap skip as terminal run status `skipped`, retaining the existing `overlap=skip: another run is already active` error text. Keep `canceled` for explicit cancellation, `cancel-previous`, and orphan reconciliation (which can also mark a queued run canceled). Report the two statuses separately in run filters and job/summary statistics.

Require `overlap: "skip"` whenever a prompt job has `reuseSession: true`, enforced by `JobSchema` on creation and update. Omitted overlap already defaults to `skip`.

## Alternatives considered

- Keep reporting overlap skips as `canceled`: this cannot distinguish a fire that never ran from work that was terminated.
- Permit `queue` with session reuse: queued turns can run against a session whose state may have changed while waiting.
- Permit `cancel-previous` with session reuse: interrupting a turn can leave the reusable session incomplete.

## Consequences

Consumers inspecting run history gain a new terminal value and separate `canceled`/`skipped` counts. Jobs that set `reuseSession: true` with `queue` or `cancel-previous` now receive `VALIDATION_ERROR` and must change their overlap policy.

## Revisit when

An engine adapter can prove a richer session concurrency policy is safe.
