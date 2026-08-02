# 0021: Duplicate job create requires explicit force

- Status: Accepted
- Date: 2026-07-28

## Context

Before this change, creating a job with an ID that already existed silently overwrote the
previous definition. That made `crontick new`, `createJob()`, MCP `crontick_job_create`,
and the HTTP `POST /api/jobs` route behave like an implicit upsert. It was convenient for
quick iteration, but it also made accidental data loss easy: re-running a setup script,
copy/pasting a command with the wrong id, or retrying automation after a partial failure
could replace the existing schedule/action without any explicit confirmation.

The risk is worse than a cosmetic surprise because job replacement is destructive in
practice: the prior schedule, action, overlap policy, retry policy, and description are
all lost unless the caller had exported or otherwise captured them first. The adjacent
CTD-004 fix also showed that validation needed to happen before persistence, so create
should not look successful and then leave mutated state behind when the new definition is
invalid.

## Decision

Creating a job is no longer a silent upsert. If the target ID already exists, crontick
rejects the create request with `JOB_ALREADY_EXISTS` and leaves the existing job
unchanged. This applies consistently on every public surface:

- CLI: `crontick new <id> ...` rejects unless `--force` is supplied.
- Library: `client.createJob(job)` rejects unless `{ force: true }` is supplied.
- MCP: `crontick_job_create` rejects unless `force: true` is supplied.
- HTTP API: `POST /api/jobs` rejects unless `?force=1` or `?force=true` is supplied.

`force` is an explicit overwrite intent on the existing create capability, not a new
replace/create variant. Users who want to modify an existing job without replacement
semantics should use update (`crontick update`, `updateJob`, `crontick_job_update`, or
`PUT /api/jobs/:id`).

Schedule validation still happens before persistence even when `force` is set, so an
invalid replacement cannot wipe out the existing job and then fail afterward.

## Alternatives considered

**Keep always-overwrite create semantics.** Rejected: it preserves the smallest API
surface but keeps the accidental-overwrite problem intact. A create command that can
silently replace a live scheduled job is too risky for automation and too surprising for a
public default.

**Warn only, but still overwrite.** Rejected: warnings are easy to miss in scripts, MCP
tool callers, and JSON-consuming automation. The failure needs to be machine-detectable
and to stop the destructive action, not merely narrate it.

**Introduce versioned jobs or historical revisions instead of rejecting.** Rejected for
now: it would preserve old definitions, but it is a much larger product/design change
covering identity, retention, scheduling, UX, and restoration semantics. The immediate
defect is the unsafe default, which explicit `force` fixes without adding revision
infrastructure.

## Consequences

**Easier:**

- Accidental duplicate creates fail safely instead of replacing an existing schedule/action.
- Automation can distinguish "new job" from "job already exists" via the stable
  `JOB_ALREADY_EXISTS` error code.
- The same intent model is visible on every surface: normal create rejects duplicates,
  explicit `force` replaces.
- Invalid replacement definitions no longer leave a broken job behind because validation
  runs before persistence.

**Harder:**

- Existing scripts that relied on silent create-as-upsert must change to `update` or add
  explicit `force`.
- "Retry the same create until it works" automation now needs to branch on
  `JOB_ALREADY_EXISTS` instead of assuming idempotent overwrite semantics.

**Impossible:**

- Silent replacement of an existing job through the default create path. Overwrite now
  always requires an explicit signal from the caller.

## Revisit when

Revisit this decision if crontick adds first-class job versioning, undo/revision history,
or another higher-level workflow that changes what "safe replacement" should mean for an
existing job definition.
