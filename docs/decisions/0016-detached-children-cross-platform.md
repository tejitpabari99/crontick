# 0016: Spawn every job process detached, identically on every platform

- Status: Accepted
- Date: 2026-07-26

## Context

Before this decision, spawned job processes were attached to the daemon's own process
tree, with platform-inconsistent effects. On POSIX, an attached child could become an
orphan when the daemon exited (reparented to init, left running but untracked -- resolved
only by best-effort process-group cleanup). On Windows, an attached child could be
terminated as a side effect of the parent process exiting, depending on how the daemon
process itself was stopped, which meant a `daemon restart` or crash could silently kill
in-flight job work on Windows while the equivalent event on POSIX left it running
untracked. Neither behavior was desirable, and the two platforms disagreed about which
undesirable thing happened.

## Decision

Every spawned child process -- script actions, exec actions, and prompt-engine
subprocesses alike -- is spawned with `detached: true, windowsHide: true`
(`src/daemon/runner.ts`). This is unconditional and identical across POSIX and Windows: a
job's process is never a child of the daemon process in the OS's process-tree sense, so
the daemon exiting (gracefully or via crash) never terminates in-flight job work as a side
effect on either platform. The child's `pid` is persisted to the run row
(`Store.updateRun({ pid })`) immediately on spawn, before any output arrives, so a
subsequent daemon start can find and reconcile it (see ADR 0014's orphan-reconciliation
companion behavior and `Store.reconcileOrphanRuns(check)`).

## Alternatives considered

**Keep attached children; document the Windows/POSIX difference.** This was the status
quo. Rejected: a daemon restart having different, platform-dependent blast radius on
in-flight work is a real correctness hazard, not a cosmetic inconsistency, and there is no
way to "just document" a data-loss-shaped platform difference into being acceptable for a
first release with a stated goal of no known limitations.

**Detach only on Windows, keep attached on POSIX.** Rejected: this keeps the platform
asymmetry (still two different behaviors, just relocated), and it is exactly the kind of
platform-specific branch this decision is trying to eliminate. Detaching everywhere is not
harder than detaching conditionally, and it is one behavior to test and reason about
instead of two.

**Use a process supervisor or process-group wrapper for children instead of the OS
`detached` flag.** Rejected as unnecessary complexity: `child_process.spawn`'s own
`detached` option already provides exactly the needed semantic (child does not share the
parent's lifecycle) on both platforms via Node's cross-platform abstraction over
`CreateProcess`/`fork`+`setsid`.

## Consequences

**Easier:**

- `daemon restart`, `daemon reload`, and an unexpected daemon crash all have one
  cross-platform answer for "what happens to jobs currently running": nothing, they keep
  running, and the next daemon start reconciles them via `pid`+start-time liveness checking
  (adopting them back into overlap tracking, or marking them canceled if the process is
  confirmed dead).
- Overlap policies (`skip`, `cancel-previous`) hold correctly across a restart, since a
  surviving run is adopted (`Runner.adoptRun()`) rather than silently forgotten.

**Harder:**

- A detached process is not automatically cleaned up by the OS when the daemon exits, so an
  orphaned run that the daemon can never observe again (e.g. its pid was reused by an
  unrelated process before the daemon restarted, and the liveness check is inconclusive) is
  adopted rather than canceled -- the daemon favors not losing track of possibly-real work
  over avoiding a possible double-run, and that trade-off is a permanent property of this
  design, not a bug to fix later.
- Detached children on Windows require `windowsHide: true` to avoid a visible console
  window per spawn; this is now a hard requirement paired with `detached`, not an
  independent cosmetic choice.

**Impossible:**

- A daemon shutdown (of any kind) instantly and reliably terminating all in-flight job
  processes as a side effect. If a run must stop when the daemon stops, that has to be an
  explicit cancellation (which still uses a direct `SIGTERM` to the tracked pid), not an
  implicit consequence of process-tree attachment.

## Revisit when

- A job type is introduced where "must die with the daemon" is the desired default
  behavior (unlikely given crontick's target use cases, but would need an opt-in flag
  rather than reversing this default).
