# 001: Job Definition

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-09-28

Audience: contributors and coding agents changing job validation, persistence, or the
CLI/MCP/library input surface. Non-duplication: this spec is the normative contract; for the
field-by-field lookup see [job-schema.md](../reference/job-schema.md), and for the conceptual
model see [concepts/jobs.md](../concepts/jobs.md).

## Summary

A job is the fundamental unit of scheduled work in crontick. Each job has a unique identity, a
schedule, a `prompt` action, and runtime policies for overlap and retry. This spec defines the
shape, validation rules, creation/mutation semantics, and persistence contract for jobs.

## Motivation

A single, well-defined job schema ensures all three surfaces (CLI, MCP, API) operate on
identical data, enables JSON Schema sidecars for editor support, and lets the daemon validate
and persist jobs without surface-specific logic.

## Terminology

| Term | Definition |
|------|-----------|
| Job | A persisted unit of scheduled work with an ID, an optional alias, a schedule, and a `prompt` action. |
| Job ID | An immutable GUID (`node:crypto` `randomUUID()`) assigned automatically at creation; the primary key used internally by the store, runs, and scheduler. |
| Alias | An optional, user-editable, kebab-case identifier unique among currently-defined jobs. Auto-generated (`<word>-<1-1000>`) when omitted. |
| Overlap policy | Determines behavior when a tick fires while a previous run is active. |
| Retry policy | Determines how many times a failed run is re-attempted. |

## Identity model: GUID `id` + optional `alias`

Every job's `id` is an immutable GUID assigned automatically on creation (never user-supplied)
and is the sole key used internally by the store, `run.jobId` references, and the scheduler. A
recreated job (same alias, deleted then re-created) never inherits a previous job's run history
or last status.

A job also has an optional, user-editable `alias`, unique across all currently-defined
(non-deleted) jobs, auto-generated from a built-in word list plus a random integer 1-1000 when
omitted (retried on collision; word list and RNG are injectable for deterministic tests). The
CLI sets this field with `--alias`/`-a`; the schema field remains `alias`, and the user-facing term everywhere (help, MCP, errors, docs) is "alias". Auto-generation falls back to `<word>-<6 char base36>` after 50 numeric attempts, and a create race against the alias UNIQUE index regenerates an auto alias (max 3 retries) while an explicit alias reports `JOB_ALREADY_EXISTS`. Every surface accepting a
job identifier (CLI positional, MCP `id` params, HTTP path segments) accepts either the GUID
`id` or the `alias`: an exact GUID match wins, otherwise the value is looked up by alias. An
unresolved identifier fails with `JOB_NOT_FOUND`.

## Requirements

### Functional requirements

- **R-001-1**: A job `alias`, when supplied, MUST match `^[a-z0-9]+(?:-[a-z0-9]+)*$` (kebab-case). The `id` field is a server-assigned GUID, never validated against this pattern.
- **R-001-2**: A job MUST have exactly one `schedule` field conforming to one of the schedule kinds (`cron`, `interval`, `one-shot`).
- **R-001-3**: A job MUST have exactly one `action` field; `kind` is a discriminant with a single member, `"prompt"` (see [ADR 0002](../decisions/0002-prompt-only-jobs-and-engine-adapters.md)).
- **R-001-4**: The `enabled` field MUST default to `true` when omitted.
- **R-001-5**: The built-in `overlap` default MUST be `"skip"`. Valid values are `skip`, `queue`, `cancel-previous`.
- **R-001-5a**: When a prompt action has `reuseSession=true` or an explicit `sessionId`, `overlap` MUST be `skip`; `queue` and `cancel-previous` MUST fail job validation.
- **R-001-6**: The built-in `retry.max` default MUST be `0`; the built-in `retry.backoffSec` default MUST be `30`.
- **R-001-6a**: A create input that omits `overlap`, `action.timeoutSec`, or either `retry` field MUST use the matching `config.json` `defaults` value, falling back to the built-in values in R-001-5/R-001-6. These are saved in the job definition at create time; a later config edit MUST NOT change an existing job, and an update patch that omits a field MUST preserve its saved value.
- **R-001-7**: The `description` field MAY be omitted; it has no behavioral effect.
- **R-001-8**: Creating a job with an alias (or GUID `id`) that already resolves to a live job MUST fail with `JOB_ALREADY_EXISTS` and leave the existing definition unchanged, unless the caller requests overwrite (`--force`, `force: true`, or `force=1|true`). See [ADR 0002](../decisions/0002-prompt-only-jobs-and-engine-adapters.md).
- **R-001-9**: Updating a job MUST merge the patch onto the existing definition, re-validate the merged result against `JobSchema`, and complete schedule validation plus any `action.envFile` preflight before any persistence. `envFile` preflight resolves relative paths against `action.cwd ?? process.cwd()`, confirms readability, and leaves the stored job unchanged on failure.
- **R-001-9a**: CLI update shorthand MUST preserve unspecified fields; `--enable`/`--disable` MUST be mutually exclusive.
- **R-001-9b**: On the API and MCP surfaces, a partial action patch that omits `prompt` but includes only modifier fields (`envFile`, `timeoutSec`, `args`, `reuseSession`, `engine`, `sessionId`) MUST be accepted; the missing `prompt` is backfilled from the existing stored action by `mergeActionPatch`. The CLI reaches advanced action patches through `jobs update --file <patch.json>`.
- **R-001-10**: Deleting a job MUST remove both the JSON file and the SQLite row; the scheduler MUST unschedule the job.
- **R-001-13**: A `prompt` action MUST have a non-empty `prompt` string. `args` MUST default to `[]` and `reuseSession` MUST default to `false`.
- **R-001-14**: The action MAY include `cwd`, `env`, `envFile`, and `timeoutSec` fields. On create `cwd` defaults to the caller's directory and is stored as an absolute, existing path.
- **R-001-14a**: Share files are `{ schema: 1, exportedAt?, crontickVersion?, jobs }` (jobs only, ids omitted on export). Import MUST validate the whole file first (a bare array, missing/other `schema` or invalid job: `VALIDATION_ERROR` naming the path, nothing imported), assign every job a new GUID, never overwrite (alias collisions become `<alias>-2`, `-3`, ... and report `renamedFrom`), and never import runs.
- **R-001-15**: The action schema MUST be strict (no unknown keys allowed).
- **R-001-16**: When a job is persisted, a JSON Schema sidecar (`<GUID id>.schema.json`) MUST be written alongside the job JSON file, keyed by the immutable GUID `id`.

### Non-functional requirements

- **R-001-17**: Validation SHOULD produce actionable Zod error messages surfaced to the user.
- **R-001-18**: The schema SHOULD be expressible as a JSON Schema for external tool consumption.

## Behavior

1. Client receives a job definition (create or update) plus any surface-specific overwrite intent, out of band from the persisted `Job` object.
2. Input is normalized via `normalizeJobInput` (reads `promptFile` if present, applies defaults).
3. The normalized input is validated against `JobSchema` (Zod discriminated union).
4. On create, a live alias/id collision without overwrite intent fails with `JOB_ALREADY_EXISTS` before any persistence.
5. Schedule validation and any `envFile` preflight run before persistence; on failure nothing is written and an existing job remains unchanged.
6. On CLI update, omitted flags leave existing fields unchanged; advanced action patches use `--file`.
7. On success, the daemon API persists via `Store.upsertJob()`: JSON file + SQLite row + schema sidecar.
8. The scheduler registers or updates the job's timer.

## Inputs and outputs

**Create input**: Full `JobInput`, plus optional overwrite intent from the calling surface.
**Update input**: Partial patch merged with the existing job; result must validate as `Job`.
**Output**: The persisted `Job` object (with defaults applied).

## Edge cases and failure modes

- Invalid alias (uppercase, spaces, dots): `VALIDATION_ERROR`.
- Job identifier not resolvable on update/delete: `JOB_NOT_FOUND` ("Job X not found (id or alias)").
- `action.cwd` missing or not a directory: `INVALID_CWD`; cwd change on a job with a session: `CWD_CHANGE_BREAKS_SESSION`; Claude folder not trusted: `TRUST_REQUIRED` (see spec 003 R-003-40).
- `schedule.tz` in new input: `VALIDATION_ERROR` (unsupported field; see spec 002).
- Missing required fields (`schedule`, `action`), or `kind: "script"`/`kind: "exec"`: `VALIDATION_ERROR`.
- Duplicate create without explicit overwrite intent: `JOB_ALREADY_EXISTS`; prior definition unchanged.
- Invalid schedule, or missing/unreadable `envFile`, on create/update: rejected before persistence.
- Job JSON with a leading UTF-8 BOM loaded from `--file`: accepted.
- Malformed job JSON from `--file`: rejected naming the file, parse location, and expected shape.
- `timeoutSec <= 0` or fractional `retry.max`: rejected by schema.

## Acceptance criteria

- [x] Kebab-case validation rejects invalid aliases (test file: `tests/unit/job-input.test.ts`)
- [x] Default values applied correctly for overlap, retry, enabled (test file: `tests/unit/property.schema.test.ts`)
- [x] Strict action schema rejects unknown keys, and `kind: "script"`/`kind: "exec"` are rejected (test file: `tests/unit/property.schema.test.ts`, `tests/unit/job-input.test.ts`)
- [x] Duplicate create rejects by default and explicit `force` replaces the existing job (test file: `tests/unit/job-create-duplicate.test.ts`)
- [x] Invalid schedule on create/update persists nothing / preserves the original job (test file: `tests/unit/job-create-atomicity.test.ts`)
- [x] Delete removes file and SQLite row (test file: `tests/unit/store.test.ts`)
- [x] Schema sidecar written on persist (test file: `tests/unit/store.test.ts`)
- [x] Prompt action validates reserved args (test file: `tests/unit/job-input.test.ts`)
- [x] Update merge semantics preserve omitted fields across CLI, MCP, and library surfaces (test files: `tests/unit/job-input.test.ts`, `tests/unit/cli.test.ts`, `tests/unit/client.test.ts`, `tests/unit/mcp.test.ts`)
- [x] Missing `envFile` on create/update is rejected before persistence; BOM-prefixed job files load and malformed job/job-patch files report file/position/expected-shape diagnostics (test files: `tests/unit/job-create-atomicity.test.ts`, `tests/unit/env-file.test.ts`, `tests/unit/job-input.test.ts`)

## Out of scope

- Schedule validation rules (see spec 002).
- Execution behavior (see spec 003).
- Prompt engine resolution and adapters (see spec 007).

## Open questions

None.

## Related

- [002-scheduling.md](002-scheduling.md)
- [003-execution.md](003-execution.md)
- [007-prompt-jobs.md](007-prompt-jobs.md)
- [../reference/job-schema.md](../reference/job-schema.md)
- [../concepts/jobs.md](../concepts/jobs.md)
- [../decisions/0002-prompt-only-jobs-and-engine-adapters.md](../decisions/0002-prompt-only-jobs-and-engine-adapters.md)
