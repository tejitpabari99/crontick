# 0027: Remove pre-production migration, legacy, and back-compatibility code

- Status: Accepted
- Date: 2026-08-03

## Context

crontick is not released and has no production installs. Despite that, the
codebase accumulated migration and back-compatibility machinery written as if
older on-disk state had to be carried forward:

- `src/daemon/store.ts` ran guarded `ALTER TABLE ... ADD COLUMN` upgrades
  (`migrateAliasColumn`, `migrateRunsSessionIdColumn`, `migrateRunsCommandColumn`)
  behind `PRAGMA table_info` probes, and migrated pre-GUID on-disk job files in
  place on startup (`migrateLegacyJobFile`), rewriting each file to a fresh
  GUID + `alias` and remapping run/schedule-state history.
- `src/job-input.ts` exported `coerceLegacyIdToAlias`, a shim that treated a
  non-GUID `id` supplied by a caller as an `alias` hint, plus a duplicated
  `UUID_PATTERN` (also present in `store.ts`).
- The daemon HTTP create/import handlers and the MCP create tool carried the
  same "legacy id becomes alias" affordance.

None of this protects any real user: there is no released schema and no legacy
job file that a real install could hold. ADR 0017 already established that
crontick has no migration framework; this decision extends that principle by
deleting the leftover legacy-coercion and per-column upgrade code so the schema
is created once, directly, in its final shape.

## Decision

Remove all migration, legacy, and back-compatibility code:

- Fold `jobs.alias`, `runs.session_id`, `runs.command`, and the unique partial
  `idx_jobs_alias` index directly into the base `CREATE TABLE/INDEX IF NOT
  EXISTS` pass. Delete the `migrateXxx` methods and the `PRAGMA table_info`
  round-trips.
- Delete `migrateLegacyJobFile` and the pre-GUID detection in
  `loadJobsFromDisk`. Job files are loaded as-is (they already carry a GUID
  `id` and optional `alias`); a file that fails to parse or validate is skipped
  with a warning, never rewritten.
- Delete `coerceLegacyIdToAlias` (and its public export from `src/index.ts`),
  the duplicated `UUID_PATTERN` in both `store.ts` and `job-input.ts`, and the
  CLI positional-`id`-as-alias-hint field. Job creation always assigns a GUID
  `id`; callers supply an `alias` for naming and pass id-or-alias for lookup.
- Drop the legacy-id affordance from the daemon HTTP create/import handlers and
  the MCP create tool.

The identity model itself (immutable GUID `id` + optional unique `alias`,
id-or-alias resolution — see ADR 0025) is unchanged. Only the migration/legacy
story around it is removed.

## Alternatives considered

**Keep the migration/legacy code "just in case."** Rejected. It guards against
inputs that cannot exist pre-release, at the cost of dead code paths, a
duplicated `UUID_PATTERN`, and per-open `PRAGMA` probes on every daemon start.

**Keep only the on-disk job-file migration.** Rejected. There are no pre-GUID
job files in existence, so the code would never run against real input.

## Consequences

- One code path creates the schema in its final shape; there is nothing to keep
  in sync between an upgrade step and a fresh `open()`.
- id-or-alias lookup no longer needs `UUID_PATTERN`: an exact GUID match is
  tried first, then an alias lookup, both by direct store query.
- Removing the public `coerceLegacyIdToAlias` export is a public-API change.
  Because it was a pre-production migration shim, this is acceptable and is
  recorded here plus in a changeset and `docs/reference/library-api.md`.
- A `runs.db` or job file produced by an earlier crontick version with a
  different shape is not a supported input (already true per ADR 0017).

## Revisit when

crontick ships a schema- or identity-breaking change after it has real
installs. At that point introduce a minimal schema-version marker and a real
migration mechanism scoped to that release forward (see ADR 0017's "Revisit
when") — not a resurrection of the pre-production legacy-coercion code removed
here.
