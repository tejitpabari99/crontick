# Core refactor plan

## Target module layout

- `src/client.ts`
  - Stable programmatic surface and only public daemon transport wrapper.
  - Owns all daemon-backed capability methods, request/response parameter names, and typed errors.
- `src/job-input.ts`
  - Job creation/update/import normalization from structured inputs.
  - Adds CLI-friendly builders so the CLI only translates flags into core inputs.
- `src/prompt-runtime.ts`
  - Single source for prompt runtime argument validation and Windows command-line estimates.
- `src/daemon/lifecycle.ts`
  - Shared start/stop/restart/status helpers over daemon ensure/probe semantics.
  - Used by client, CLI, and MCP; no pid/port manipulation in shims.
- `src/doctor.ts`
  - Shared structured doctor checks; no console output, no MCP/CLI formatting.
- `src/schema-json.ts`
  - Shared JSON Schema generation for job schema resources/artifacts.
- `src/surface.ts`
  - Declarative capability table used by drift tests and thin adapter checks.
- `src/index.ts`
  - Clean public exports: version, error, client factory/class/options, job types/schemas, schema helper.
  - No direct daemon/path internals.

## Final client method list

- `ensure()`
- `health(options?)`
- `createJob(input, options?)`
- `createJobFromCliOptions(input)`
- `listJobs()`
- `getJob(id)`
- `updateJob(id, patch, options?)`
- `deleteJob(id)`
- `enableJob(id)`
- `disableJob(id)`
- `runNow(id)`
- `cancelRun(runId)`
- `getRun(runId)`
- `listRuns(options?)`
- `getLogs(runId, options?)`
- `exportJobs()`
- `importJobs(jobs, options?)`
- `validateSchedule(schedule)`
- `previewSchedule(input)`
- `statsSummary()`
- `statsJob(id)`
- `daemonStart(options?)`
- `daemonStop()`
- `daemonRestart()`
- `daemonReload()`
- `daemonStatus()`
- `doctor(options?)`
- `dashboardStart(options?)`, `dashboardStatus()`, `dashboardData(options?)`, `dashboardStop()`
- `jobJsonSchema()`

## Change order

1. Add shared prompt runtime validation and switch schemas/job-input to it.
2. Add schema JSON generator and job-create builders in core.
3. Add daemon lifecycle and doctor core helpers.
4. Expand `CrontickClient` with missing capability methods and normalized request/response options.
5. Refactor CLI commands to parse flags, call client/core, and render output only.
6. Refactor MCP tools/resources/prompts to call `CrontickClient` and shared schemas/helpers only.
7. Narrow package root exports and update docs.
8. Add unit and drift tests, then run typecheck, lint, build, and tests.
