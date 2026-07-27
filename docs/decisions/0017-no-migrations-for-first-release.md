# 0017: No migration framework for the v1.0.0 schema

- Status: Accepted
- Date: 2026-07-26

## Context

Before this decision, `src/daemon/store.ts` tracked applied schema changes in a
`migrations` table and ran a small ordered list of named SQL scripts (`001_initial`,
`002_run_retention_index`) on every `open()`. This made sense while the schema was still
settling during pre-release development across several 0.x versions. crontick has zero
users and no released schema to be compatible with: v1.0.0 is the first real release, and
every 0.x `runs.db` this migration list existed to carry forward is not a database any
real user has. Carrying a migration framework, and the ongoing discipline of writing a new
migration for every future schema change, forward into v1.0.0 for a compatibility
requirement that does not exist is unjustified complexity.

## Decision

Remove the migration framework entirely. `createSchema()` creates the full v1.0.0 schema
-- `jobs`, `runs` (including `pid` and `output_truncated`), `run_logs`,
`job_schedule_state`, and the indexes `idx_runs_job_id_started_at`, `idx_runs_started_at`,
`idx_run_logs_run_id` -- in one idempotent pass of `CREATE TABLE/INDEX IF NOT EXISTS`
statements, every time the store opens. There is no `migrations` table, no schema-version
tracking, and no migration runner. A `runs.db` produced by a crontick version before
1.0.0 is explicitly unsupported: opening the store against one is not detected specially
and is not guaranteed to work.

Future schema changes after 1.0.0 will need their own compatibility decision at that time
(see Revisit when) -- this ADR covers the v1.0.0 schema only, not a permanent policy of
"crontick will never migrate a schema."

## Alternatives considered

**Keep the migration framework, add `003_...`/`004_...` entries for this diff's new
tables/columns.** Rejected for v1.0.0: this preserves compatibility with 0.x databases
that no user has, at the ongoing cost of a migration-writing discipline for every future
schema change, in exchange for a benefit (upgrading an 0.x install) that does not exist.
The right time to add a migration framework is when there is a released schema that must
be preserved across an upgrade -- which starts at v1.0.0, not before it.

**Keep the migration framework but mark it "for future use," with no migrations recorded
for this diff's changes.** Rejected: this keeps the machinery and its associated code
paths and tests without any current benefit, which is exactly the unjustified complexity
this decision removes. An unused mechanism is not free -- it is still code that must be
understood, tested, and kept correct.

**Version the schema and fail loudly if an old `runs.db` is detected.** Considered as a
softer landing than silent unsupported behavior. Deferred, not rejected outright: for
v1.0.0 with zero existing users there is no real database this would ever fire against, so
the detection code itself would be untested-in-practice complexity added purely for a
hypothetical. If crontick ever needs to change the v1.0.0 schema in a way that breaks
existing 1.x databases, a version check and a real migration mechanism should be
introduced together at that point (see Revisit when).

## Consequences

**Easier:**

- One code path creates the schema; there is nothing to keep in sync between "the
  migration list" and "what a fresh `open()` produces" -- they are the same thing.
- Adding a table or column going forward within the 1.x schema's stable shape is a direct,
  additive change to `createSchema()` guarded by `IF NOT EXISTS`, not a new migration file.
- No migration-ordering bugs, no partially-applied-migration-list failure states to handle.

**Harder:**

- Nothing to harden the schema-evolution story going forward within v1.0.0 itself; this ADR
  intentionally does not solve "how will crontick change its schema after v1.0.0
  ships"--that is a future decision, made when there are real installs to consider.

**Impossible:**

- Opening a `runs.db` created by a crontick version before 1.0.0 and having it work. This is
  explicit and intentional: 0.1.1 databases are unsupported input, not a regression.
- Upgrading in place from a pre-1.0.0 install without deleting `runs.db`. There is no
  released version to upgrade from, so this is not a capability v1.0.0 needs to have.

## Revisit when

- crontick ships a schema-breaking change after v1.0.0 has real installs. At that point,
  introduce a minimal schema-version marker and a migration mechanism scoped to 1.x-and-
  later compatibility -- deliberately not resurrecting the pre-1.0.0 migration list, which
  was never exercised against a real upgrade.
