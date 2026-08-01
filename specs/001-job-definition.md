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
- **R-001-8**: Creating a job with an existing ID MUST fail with `JOB_ALREADY_EXISTS` and MUST leave the existing definition unchanged, unless the caller explicitly requests overwrite intent (`--force` on the CLI, `force: true` on library/MCP, or `force=1|true` on the HTTP route). This is a breaking change from the earlier silent-upsert create behavior; see ADR 0021.
- **R-001-9**: Updating a job MUST merge the patch onto the existing definition, re-validate the merged result against `JobSchema`, and complete schedule validation plus any `action.envFile` preflight before any persistence. `action.envFile` preflight MUST resolve relative paths against `action.cwd ?? process.cwd()`, confirm the file is readable, and leave the previously stored job unchanged on failure.
- **R-001-9a**: CLI update shorthand MUST fail loudly when a modifier flag cannot identify the sub-object it would patch. Specifically, `--shell`, `--job-env-file`, and `--timeout` MUST require an accompanying action source (`--script`, `--exec`, `--prompt`, or `--prompt-file`) on `crontick update`, and `--tz` MUST require `--cron` on `crontick update`. These invocations MUST return `VALIDATION_ERROR` and MUST leave the stored job unchanged instead of silently succeeding with no effect.
- **R-001-9b**: On the API and MCP surfaces, a partial action patch that omits the action source (`script`, `command`, or `prompt`) but includes only modifier fields (`shell`, `envFile`, `timeoutSec`, `args`, `reuseSession`) MUST be accepted. The missing source field is backfilled from the existing stored action by `mergeActionPatch`. A kind-change patch (e.g. `kind: 'exec'` on a `script` job) still fully replaces the action. This requirement applies to `JobPatchInputSchema` and `normalizeJobPatch`; the CLI's `--shell`/`--job-env-file`/`--timeout`-without-source guard (R-001-9a) is a CLI-only UX constraint that is not weakened by this requirement.
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

1. Client receives a job definition (create or update), plus any surface-specific overwrite intent (`--force`, `force: true`, or `force=1|true`) out of band from the persisted `Job` object. The persisted field name is `action.envFile` on every surface; the CLI option name for that field is `--job-env-file`.
2. Input is normalized via `normalizeJobInput` (reads `promptFile` if present, applies defaults).
3. The normalized input is validated against `JobSchema` (Zod discriminated union).
4. On create, if the ID already exists and overwrite intent was not supplied, the operation fails with `JOB_ALREADY_EXISTS` before any persistence.
5. Schedule validation and any `action.envFile` preflight run before any persistence; if either fails, no new job is written and an existing job remains unchanged.
6. On CLI update, shorthand modifier flags that do not identify a target sub-object (`--shell`, `--job-env-file`, `--timeout` without an action source, or `--tz` without `--cron`) fail before persistence instead of being silently ignored.
7. On success, the daemon API persists via `Store.upsertJob()`: writes JSON file + SQLite row + schema sidecar.
8. The scheduler is invoked to register or update the timer for the job.
9. On update, the existing job is fetched, merged with the patch, and re-validated as a full job before persistence.

## Inputs and outputs

**Create input**: Full `JobInput` (Zod input type of `JobSchema`), plus optional overwrite intent supplied by the calling surface rather than stored on the `Job` itself.
**Update input**: Partial patch merged with existing job; result must validate as `Job`.
**Output**: The persisted `Job` object (with defaults applied).

## Edge cases and failure modes

- Invalid job ID (uppercase, spaces, dots): MUST reject with `VALIDATION_ERROR`.
- Missing required fields (`schedule`, `action`): MUST reject with `VALIDATION_ERROR`.
- Unknown keys in action object: MUST reject (strict schemas).
- Job ID not found on update/delete: MUST return `NOT_FOUND` error.
- Duplicate create without explicit overwrite intent: MUST reject with `JOB_ALREADY_EXISTS`; the prior job definition remains unchanged.
- Invalid schedule on create/update: MUST reject before persistence, so create writes nothing and update preserves the prior job.
- `action.envFile` missing or unreadable on create/update: MUST reject with `ENV_FILE_ERROR` before persistence; relative paths are resolved against `action.cwd ?? process.cwd()`.
- CLI update `--shell`, `--job-env-file`, or `--timeout` without an action source: MUST reject with `VALIDATION_ERROR` and preserve the existing job instead of silently succeeding.
- CLI update `--tz` without `--cron` (including `--tz` by itself or alongside `--every` / `--at`): MUST reject with `VALIDATION_ERROR` and preserve the existing job instead of silently succeeding.
- Create/update job JSON loaded from `--file` with a leading UTF-8 BOM: MUST be accepted.
- Malformed create/update job JSON loaded from `--file`: MUST reject with a message that names the file, parse location, and expected job/job-patch shape. EOF-truncated files MUST report the end-of-input location and, when inferable, what construct or token was still expected.
- `timeoutSec` <= 0: MUST reject (schema requires `.positive()`).
- `retry.max` with fractional value: MUST reject (schema requires `.int()`).

## Acceptance criteria

- [x] Kebab-case validation rejects invalid IDs (test file: `tests/job-input.test.ts`)
- [x] Default values applied correctly for overlap, retry, enabled (test file: `tests/property.schema.test.ts`)
- [x] Strict action schemas reject unknown keys (test file: `tests/property.schema.test.ts`)
- [x] Duplicate create rejects by default and explicit `force` replaces the existing job (test file: `tests/job-create-duplicate.ctd-005.test.ts`)
- [x] Invalid schedule on create/update persists nothing / preserves the original job (test file: `tests/job-create-atomicity.ctd-004.test.ts`)
- [x] Delete removes file and SQLite row (test file: `tests/store.test.ts`)
- [x] Schema sidecar written on persist (test file: `tests/store.test.ts`)
- [x] Prompt action validates reserved args (test file: `tests/job-input.test.ts`)
- [x] Update merge semantics tested end-to-end (CLI and MCP) (test files: `tests/cli.test.ts`, `tests/mcp.test.ts`)
- [x] Update shorthand audit proves every CLI `update` flag either applies or fails loudly, with explicit regression coverage for `--shell`, `--job-env-file`, `--timeout`, and `--tz` (test files: `tests/job-input.test.ts`, `tests/cli.test.ts`, `tests/client.test.ts`, `tests/mcp.test.ts`)
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
- `../docs/reference/`
- `../docs/concepts/`
