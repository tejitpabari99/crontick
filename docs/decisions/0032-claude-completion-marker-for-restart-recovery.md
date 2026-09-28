# 0032: Use Claude completion markers only for restart recovery

- Status: Accepted
- Date: 2026-09-28

## Context

The daemon can lose a child process's exit code when it stops before the child
finishes. On restart, liveness can tell whether the child is still running,
but an adopted run that later exits otherwise gets an unknown-exit fallback.
Normal Claude runs already have a definitive result from stream-json output
and the child exit code.

## Decision

Each Claude invocation appends inline `--settings` JSON registering a
`SessionEnd` command hook. The hook writes `{exitStatus, sessionId}` under the
crontick data directory. It does not edit the user's Claude settings. Restart
reconciliation and the adopted-run poll accept a marker only when its session
ID matches the persisted run and its exit status is an integer from 0 to 255.
An absent or incomplete marker leaves existing fallback behavior in place.
Explicit cancellation overrides a marker.

Normal runs always use `parseResult` and the process exit; the marker never
sets their outcome or makes a session eligible for resume. The runner removes
markers after normal attempts so an earlier retry attempt cannot be mistaken
for a later one.

## Consequences

Restart recovery can record a success or failure exit code for a Claude run
that finished while the daemon was unavailable. The marker cannot convey
Claude's `is_error` result or usage fields, so those remain unknown after a
restart. Hook firing and payload in noninteractive `-p` mode still require
owner live validation; when no usable exit status is provided, recovery keeps
the prior unknown-exit fallback.
