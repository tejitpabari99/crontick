# 001: Job Definition

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-07-25

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
| Job | A persisted unit of scheduled work with an ID, schedule, and action. |
| Action | The executable payload of a job; one of `script`, `exec`, or `prompt`. |
| Job ID | A kebab-case string uniquely identifying a job. |
| Overlap policy | Determines behavior when a tick fires while a previous run is active. |
| Retry policy | Determines how many times a failed run is re-attempted. |

## Requirements

### Functional requirements

- **R-001-1**: A job ID MUST match the regex `^[a-z0-9]+(?:-[a-z0-9]+)*$` (kebab-case).
- **R-001-2**: A job MUST have exactly one `schedule` field conforming to one of the schedule kinds (`cron`, `interval`, `one-shot`).
- **R-001-3**: A job MUST have exactly one `action` field whose `kind` discriminator selects `script`, `exec`, or `prompt`.
- **R-001-4**: The `enabled` field MUST default to `true` when omitted.
- **R-001-5**: The `overlap` field MUST default to `"skip"` when omitted. Valid values are `skip`, `queue`, `cancel-previous`.
- **R-001-6**: The `retry.max` field MUST default to `0`; `retry.backoffSec` MUST default to `30`.
- **R-001-7**: The `description` field MAY be omitted; it has no behavioral effect.
- **R-001-8**: Creating a job with an existing ID MUST upsert (overwrite) the previous definition.
- **R-001-9**: Updating a job MUST merge the patch onto the existing definition and re-validate the merged result against `JobSchema`.
- **R-001-10**: Deleting a job MUST remove both the JSON file and the SQLite row; the scheduler MUST unschedule the job.
- **R-001-11**: A `script` action MUST have a non-empty `script` string. The `shell` field MUST default to `"auto"`.
- **R-001-12**: An `exec` action MUST have a non-empty `command` string. The `args` field MUST default to `[]`.
- **R-001-13**: A `prompt` action MUST have a non-empty `prompt` string. The `args` field MUST default to `[]` and `reuseSession` MUST default to `false`.
- **R-001-14**: All action kinds MAY include `cwd`, `env`, `envFile`, and `timeoutSec` fields.
- **R-001-15**: Action schemas MUST be strict (no unknown keys allowed).
- **R-001-16**: When a job is persisted, a JSON Schema sidecar (`<id>.schema.json`) MUST be written alongside the job JSON file.

### Non-functional requirements

- **R-001-17**: Validation SHOULD produce actionable Zod error messages surfaced to the user.
- **R-001-18**: The schema SHOULD be expressible as a JSON Schema for external tool consumption.

## Behavior

1. Client receives a job definition (create or update).
2. Input is normalized via `normalizeJobInput` (reads `promptFile` if present, applies defaults).
3. The normalized input is validated against `JobSchema` (Zod discriminated union).
4. On success, the daemon API persists via `Store.upsertJob()`: writes JSON file + SQLite row + schema sidecar.
5. The scheduler is invoked to register or update the timer for the job.
6. On update, the existing job is fetched, merged with the patch, and re-validated as a full job.

## Inputs and outputs

**Create input**: Full `JobInput` (Zod input type of `JobSchema`).
**Update input**: Partial patch merged with existing job; result must validate as `Job`.
**Output**: The persisted `Job` object (with defaults applied).

## Edge cases and failure modes

- Invalid job ID (uppercase, spaces, dots): MUST reject with `VALIDATION_ERROR`.
- Missing required fields (`schedule`, `action`): MUST reject with `VALIDATION_ERROR`.
- Unknown keys in action object: MUST reject (strict schemas).
- Job ID not found on update/delete: MUST return `NOT_FOUND` error.
- Duplicate create: silent upsert (not an error).
- `timeoutSec` <= 0: MUST reject (schema requires `.positive()`).
- `retry.max` with fractional value: MUST reject (schema requires `.int()`).

## Acceptance criteria

- [x] Kebab-case validation rejects invalid IDs (test file: `tests/job-input.test.ts`)
- [x] Default values applied correctly for overlap, retry, enabled (test file: `tests/property.schema.test.ts`)
- [x] Strict action schemas reject unknown keys (test file: `tests/property.schema.test.ts`)
- [x] Upsert overwrites existing job (test file: `tests/store.test.ts`)
- [x] Delete removes file and SQLite row (test file: `tests/store.test.ts`)
- [x] Schema sidecar written on persist (test file: `tests/store.test.ts`)
- [x] Prompt action validates reserved args (test file: `tests/job-input.test.ts`)
- [ ] Update merge semantics tested end-to-end (CLI and MCP)

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
- `../docs/reference/`
- `../docs/concepts/`
