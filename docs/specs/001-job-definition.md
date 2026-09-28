# 001: Job Definition

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-07-31

## Summary

A job is the fundamental unit of scheduled work in crontick. Each job has a unique
identity, a schedule, an action (one of three kinds), and runtime policies for overlap
and retry. This spec defines the shape, validation rules, creation/mutation semantics,
and persistence contract for jobs.

## Motivation

A single, well-defined job schema ensures all three surfaces (CLI, MCP, API) operate
on identical data, enables JSON Schema sidecars for editor support, and allows the
daemon to validate and persist jobs without surface-specific logic.

## Terminology

| Term | Definition |
|------|-----------|
| Job | A persisted unit of scheduled work with an ID, an optional alias, a schedule, and an action. |
| Action | The executable payload of a job; one of `script`, `exec`, or `prompt`. |
| Job ID | An immutable GUID (`node:crypto` `randomUUID()`) assigned automatically at creation; the primary key used internally by the store, runs, and scheduler. |
| Alias | An optional, user-editable, kebab-case human-friendly identifier unique among currently-defined jobs. Auto-generated (`<word>-<1-1000>`) when omitted. |
| Overlap policy | Determines behavior when a tick fires while a previous run is active. |
| Retry policy | Determines how many times a failed run is re-attempted. |

## Identity model: GUID `id` + optional `alias`

Every job's `id` is an immutable GUID assigned automatically on creation (never
user-supplied) and is the sole key used internally by the store, `run.jobId`
references, and the scheduler. This guarantees a recreated job (same alias,
deleted then re-created) never inherits a previous job's run history or last
status -- a stale identifier can no longer collide with a live job's identity.

A job also has an optional, user-editable `alias`: a kebab-case string unique
across all currently-defined (non-deleted) jobs. When omitted on create, an
alias is auto-generated from a small built-in word list plus a random integer
1-1000 (retried on collision); the word list and RNG are injectable so this is
deterministic in tests. The CLI sets this field with `--name` on `jobs new`
and `jobs update`; the job schema field remains `alias`. Every surface that accepts a job identifier (CLI
positional, MCP `id` params, HTTP path segments) accepts EITHER the GUID `id`
OR the `alias` and resolves it internally: an exact GUID match wins, otherwise
the value is looked up by alias. An unresolved identifier fails with
`JOB_NOT_FOUND`.

## Requirements

### Functional requirements

- **R-001-1**: A job `alias`, when supplied, MUST match the regex `^[a-z0-9]+(?:-[a-z0-9]+)*$` (kebab-case). The `id` field is a server-assigned GUID and is never validated against this pattern.
- **R-001-2**: A job MUST have exactly one `schedule` field conforming to one of the schedule kinds (`cron`, `interval`, `one-shot`).
- **R-001-3**: A job MUST have exactly one `action` field whose `kind` discriminator selects `script`, `exec`, or `prompt`.
- **R-001-4**: The `enabled` field MUST default to `true` when omitted.
- **R-001-5**: The built-in `overlap` default MUST be `"skip"`. Valid values are `skip`, `queue`, `cancel-previous`.
- **R-001-5a**: When a prompt action has `reuseSession=true`, `overlap` MUST be `skip`; `queue` and `cancel-previous` MUST fail job validation.
- **R-001-6**: The built-in `retry.max` default MUST be `0`; the built-in `retry.backoffSec` default MUST be `30`.
- **R-001-6a**: A create input that omits `overlap`, `action.timeoutSec`, or either `retry` field MUST use the matching `config.json` `defaults` value, falling back to the built-in values in R-001-5/R-001-6 (with no built-in timeout). These values MUST be saved in the job definition at create time. A later config edit MUST NOT change an existing job, and an update patch that omits a field MUST preserve its saved value.
- **R-001-7**: The `description` field MAY be omitted; it has no behavioral effect.
- **R-001-8**: Creating a job with an alias (or GUID `id`) that already resolves to a live job MUST fail with `JOB_ALREADY_EXISTS` and MUST leave the existing definition unchanged, unless the caller explicitly requests overwrite intent (`--force` on the CLI, `force: true` on library/MCP, or `force=1|true` on the HTTP route). This is a breaking change from the earlier silent-upsert create behavior; see ADR 0021.
- **R-001-9**: Updating a job MUST merge the patch onto the existing definition, re-validate the merged result against `JobSchema`, and complete schedule validation plus any `action.envFile` preflight before any persistence. `action.envFile` preflight MUST resolve relative paths against `action.cwd ?? process.cwd()`, confirm the file is readable, and leave the previously stored job unchanged on failure.
- **R-001-9a**: CLI update shorthand MUST preserve unspecified fields. `crontick jobs update` MUST leave any omitted option unchanged, and `--enable` / `--disable` MUST be mutually exclusive.
- **R-001-9b**: On the API and MCP surfaces, a partial action patch that omits the action source (`script`, `command`, or `prompt`) but includes only modifier fields (`shell`, `envFile`, `timeoutSec`, `args`, `reuseSession`) MUST be accepted. The missing source field is backfilled from the existing stored action by `mergeActionPatch`. A kind-change patch (e.g. `kind: 'exec'` on a `script` job) still fully replaces the action. This requirement applies to `JobPatchInputSchema` and `normalizeJobPatch`; the CLI reaches advanced action patches through `jobs update --file <patch.json>` rather than dedicated modifier flags.
- **R-001-10**: Deleting a job MUST remove both the JSON file and the SQLite row; the scheduler MUST unschedule the job.
- **R-001-11**: A `script` action MUST have a non-empty `script` string. The `shell` field MUST default to `"auto"`.
- **R-001-12**: An `exec` action MUST have a non-empty `command` string. The `args` field MUST default to `[]`.
- **R-001-13**: A `prompt` action MUST have a non-empty `prompt` string. The `args` field MUST default to `[]` and `reuseSession` MUST default to `false`.
- **R-001-14**: All action kinds MAY include `cwd`, `env`, `envFile`, and `timeoutSec` fields.
- **R-001-15**: Action schemas MUST be strict (no unknown keys allowed).
- **R-001-16**: When a job is persisted, a JSON Schema sidecar (`<GUID id>.schema.json`) MUST be written alongside the job JSON file (`<GUID id>.json`), keyed by the immutable GUID `id`, not the alias.

### Non-functional requirements

- **R-001-17**: Validation SHOULD produce actionable Zod error messages surfaced to the user.
- **R-001-18**: The schema SHOULD be expressible as a JSON Schema for external tool consumption.

## Behavior

1. Client receives a job definition (create or update), plus any surface-specific overwrite intent (`--force`, `force: true`, or `force=1|true`) out of band from the persisted `Job` object. The persisted field name is `action.envFile`; the CLI sets it only through full job/patch JSON supplied with `--file`.
2. Input is normalized via `normalizeJobInput` (reads `promptFile` if present, applies defaults).
3. The normalized input is validated against `JobSchema` (Zod discriminated union).
4. On create, if the alias already resolves to a live job and overwrite intent was not supplied, the operation fails with `JOB_ALREADY_EXISTS` before any persistence.
5. Schedule validation and any `action.envFile` preflight run before any persistence; if either fails, no new job is written and an existing job remains unchanged.
6. On CLI update, omitted flags leave existing fields unchanged; advanced action patches use `--file` rather than dedicated action modifier flags.
7. On success, the daemon API persists via `Store.upsertJob()`: writes JSON file + SQLite row + schema sidecar.
8. The scheduler is invoked to register or update the timer for the job.
9. On update, the existing job is fetched, merged with the patch, and re-validated as a full job before persistence.

## Inputs and outputs

**Create input**: Full `JobInput` (Zod input type of `JobSchema`), plus optional overwrite intent supplied by the calling surface rather than stored on the `Job` itself.
**Update input**: Partial patch merged with existing job; result must validate as `Job`.
**Output**: The persisted `Job` object (with defaults applied).

## Edge cases and failure modes

- Invalid job alias (uppercase, spaces, dots): MUST reject with `VALIDATION_ERROR`.
- Job identifier (GUID `id` or alias) not resolvable on update/delete: MUST return a `JOB_NOT_FOUND` error.
- Missing required fields (`schedule`, `action`): MUST reject with `VALIDATION_ERROR`.
- Unknown keys in action object: MUST reject (strict schemas).
- Duplicate create without explicit overwrite intent: MUST reject with `JOB_ALREADY_EXISTS`; the prior job definition remains unchanged.
- Invalid schedule on create/update: MUST reject before persistence, so create writes nothing and update preserves the prior job.
- `action.envFile` missing or unreadable on create/update: MUST reject with `ENV_FILE_ERROR` before persistence; relative paths are resolved against `action.cwd ?? process.cwd()`.
- Create/update job JSON loaded from `--file` with a leading UTF-8 BOM: MUST be accepted.
- Malformed create/update job JSON loaded from `--file`: MUST reject with a message that names the file, parse location, and expected job/job-patch shape. EOF-truncated files MUST report the end-of-input location and, when inferable, what construct or token was still expected.
- `timeoutSec` <= 0: MUST reject (schema requires `.positive()`).
- `retry.max` with fractional value: MUST reject (schema requires `.int()`).

## Acceptance criteria

- [x] Kebab-case validation rejects invalid IDs (test file: `tests/job-input.test.ts`)
- [x] Default values applied correctly for overlap, retry, enabled (test file: `tests/property.schema.test.ts`)
- [x] Strict action schemas reject unknown keys (test file: `tests/property.schema.test.ts`)
- [x] Duplicate create rejects by default and explicit `force` replaces the existing job (test file: `tests/job-create-duplicate.test.ts`)
- [x] Invalid schedule on create/update persists nothing / preserves the original job (test file: `tests/job-create-atomicity.ctd-004.test.ts`)
- [x] Delete removes file and SQLite row (test file: `tests/store.test.ts`)
- [x] Schema sidecar written on persist (test file: `tests/store.test.ts`)
- [x] Prompt action validates reserved args (test file: `tests/job-input.test.ts`)
- [x] Update merge semantics tested end-to-end (CLI and MCP) (test files: `tests/cli.test.ts`, `tests/mcp.test.ts`)
- [x] Update merge semantics preserve omitted fields across CLI, MCP, and library surfaces (test files: `tests/job-input.test.ts`, `tests/cli.test.ts`, `tests/client.test.ts`, `tests/mcp.test.ts`)
- [x] Missing `envFile` on create/update is rejected before persistence, while BOM-prefixed job files still load and malformed job/job-patch files report file/position/expected-shape diagnostics (test files: `tests/job-create-atomicity.ctd-004.test.ts`, `tests/env-file.test.ts`, `tests/job-input.test.ts`, `tests/cli.test.ts`, `tests/mcp.test.ts`)

## Out of scope

- Schedule validation rules (see spec 002).
- Execution behavior (see spec 003).
- Prompt engine resolution (see spec 007).

## Open questions

None.

## Related

- [002-scheduling.md](002-scheduling.md)
- [003-execution.md](003-execution.md)
- [007-prompt-jobs.md](007-prompt-jobs.md)
- `../reference/`
- `../concepts/`
