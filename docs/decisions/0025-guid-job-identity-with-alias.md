# 0025: GUID job identity with an optional human-friendly alias

- Status: Accepted
- Date: 2026-08-02

## Context

Originally a job's `id` was a user-supplied human string that also served as the
primary key in JSON persistence and the SQLite cache, and as the value each
`run.jobId` referenced. Because the key was a reusable human string, deleting a
job and recreating it with the same `id` re-bound the new job to the old job's
run history. The dashboard and stats then showed the previous job's "last
status" and run list for what the user considered a brand-new job. The identifier
was doing two incompatible jobs at once: a stable internal key and a friendly,
editable label.

## Decision

Split job identity into two fields:

- `id` — an immutable, server-assigned GUID (`node:crypto` `randomUUID()`),
  generated at creation and never user-supplied. It is the sole primary key in
  JSON persistence and the SQLite cache, and the value `run.jobId` references.
- `alias` — an optional, user-editable, kebab-case
  (`^[a-z0-9]+(?:-[a-z0-9]+)*$`) name, unique among currently-defined (live)
  jobs. When omitted on create, crontick auto-generates `<word>-<1-1000>` from a
  built-in word list, retrying on collision (`generateAlias`). A job can be
  renamed by editing its `alias` via `update` — no delete/recreate required.

Anywhere a job identifier is accepted (CLI positional `<id>`, MCP `id` params,
HTTP path segments, the `--job`/`jobId` run filter), callers may pass either the
GUID `id` or the `alias`. Resolution tries an exact GUID match first, then falls
back to an alias lookup, and returns `JOB_NOT_FOUND` when neither matches.

Because runs are permanently tied to the GUID rather than a reusable human
string, deleting a job and recreating it (even reusing the same alias) never
inherits the previous job's run history or dashboard status.

Jobs are created directly in the GUID + `alias` shape: `id` is a fresh GUID and
`alias` is either caller-supplied or auto-generated. There is no on-disk
migration and no coercion of a non-GUID `id` to an alias -- crontick is
pre-production, so no legacy job files exist to convert (see
[ADR 0027](0027-remove-pre-production-migration-and-legacy-code.md)).

## Alternatives considered

**Keep the human string as the primary key and forbid reuse after delete.**
Rejected. Blocking reuse of a friendly name is surprising, and it would not fix
the underlying conflation of "stable key" and "editable label."

**Tombstone deleted ids so recreated jobs get a fresh internal key while keeping
the human id public.** Rejected. Tombstones accumulate, complicate export/import,
and still leak internal state into a user-facing identifier.

**Require users to supply a GUID.** Rejected. GUIDs are not human-friendly for
day-to-day CLI use; auto-assigning the GUID and accepting a friendly alias keeps
the ergonomics while fixing the key.

## Consequences

**Easier / safer:**

- Run history and dashboard status can never bleed across a delete/recreate.
- Jobs can be renamed freely without losing history.
- Every surface accepts the familiar friendly name or the stable GUID.

**Harder / accepted tradeoffs:**

- Two identity fields must be kept consistent everywhere jobs are serialized.
- Aliases are unique only among live jobs, so a freed alias can later point at a
  different GUID than it once did — callers that cached a run's `jobId` should key
  on the GUID, not the alias.

## Revisit when

Revisit if aliases need to be globally unique across deleted jobs, or if a future
schema requires stable external identifiers beyond the GUID/alias pair.
