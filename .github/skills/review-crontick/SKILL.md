---
name: review-crontick
description: Use when reviewing crontick code changes or PRs to enforce the single-core/thin-shim architecture, detect drift between CLI/MCP/API surfaces, and flag dead code or unnecessary dependencies.
---

# review-crontick

Review a crontick change for architecture conformance. Report correctness and
surface-parity issues only; do not nitpick formatting or style.

## When to use

Use when a local diff or PR touches `src\`, `tests\`, `docs\`, `package.json`,
`plugin\`, public examples, CLI commands, MCP tools/resources/prompts, package
exports, client methods, schemas, daemon endpoints, scheduler behavior, or
persisted state. Be especially suspicious of changes described as "just CLI",
"just MCP", "just docs", or "just schema" because those often create drift.

Do not use for formatting-only diffs or dependency-only updates with no code, public API, or documented behavior change.
## How to get the change set

Run the relevant commands:

```powershell
# discover scope
git --no-pager status --short
git --no-pager diff --stat
git --no-pager diff --name-only

# unstaged changes
git --no-pager diff --stat
git --no-pager diff

# staged changes
git --no-pager diff --staged --stat
git --no-pager diff --staged

# branch against a base
git --no-pager diff <base>...HEAD --stat
git --no-pager diff <base>...HEAD

# GitHub PR
gh pr diff <pr-number> --repo tejitpabari99/crontick
gh pr diff <pr-number> --repo tejitpabari99/crontick --patch
```

If the PR is checked out locally, prefer `git --no-pager diff <base>...HEAD` so
`file:line` citations match the workspace.

## Repo map

Core/source-of-truth areas:

- `src\client.ts` - public `CrontickClient` / `createClient()` API. Public
  capabilities should appear here first.
- `src\job-input.ts` - job input normalization and prompt-file handling.
- `src\schemas\job.ts` - authoritative Zod job/schedule/action schemas/types.
- `src\errors.ts` - typed `CrontickError` shape.
- `src\daemon\api.ts` - internal loopback HTTP transport boundary.
- `src\daemon\store.ts`, `src\daemon\scheduler.ts`, `src\daemon\runner.ts`,
  `src\daemon\ensure.ts` - durable state, scheduling, execution, lifecycle.

Thin shims/surfaces:

- `src\cli\index.ts` - Commander CLI. It may parse flags, call core/client, and
  render results.
- `src\mcp\index.ts` - stdio MCP adapter with `crontick_*` tools/resources. It
  may define MCP schemas/descriptions/confirmations and render tool results.
- `src\index.ts` - package export facade; must not become a second core.
- `src\skill\SKILL.md`, `plugin\install.mjs`, `src\dashboard\` - agent/plugin/UI
  surfaces; domain behavior here is suspect unless delegated to core/daemon.

Context: `package.json` ships `crontick`, `crontick-daemon`, and `crontick-mcp`;
the architecture and roadmap docs make client/core source-of-truth and
MCP/client drift explicit.

## Checkable architecture rubric

1. **Single core, thin shims.**
   - Check that changed CLI/MCP/API behavior delegates to the same core/client
     method or daemon primitive.
   - Violation: adding `crontick stats` in `src\cli\index.ts` with direct
     `/stats` fetch logic while MCP has `crontick_stats_summary` and the client
     lacks `statsSummary()`.
   - Fix: add/extend `src\client.ts`, test it, then call it from shims.

2. **No proprietary/business logic in a shim.**
   - Check that shims do not do scheduling math, state mutation, persistence,
     child-process spawning, schema generation, domain defaults/validation, or
     domain error construction.
   - Violation: `src\cli\index.ts` computing next cron times, writing job JSON,
     spawning prompt engines, or constructing job-domain `CrontickError`s.
   - Fix: move behavior to `src\client.ts`, `src\job-input.ts`,
     `src\schemas\job.ts`, or `src\daemon\*`; keep parsing/rendering in shims.

3. **No drift between surfaces.**
   - Check that each conceptual operation has a core/client method first and
     matching CLI/MCP names, parameters, semantics, defaults, and errors when
     the surface applies.
   - Violation: MCP exposes `crontick_job_cancel_run` but the client has no
     `cancelRun()`, or CLI `run-now` accepts different identifiers/defaults than
     MCP/client.
   - Fix: define once in `CrontickClient` and add parity coverage in
     `tests\client.test.ts`, `tests\cli.test.ts`, and `tests\mcp.test.ts`.

4. **Core stays transport-agnostic.**
   - Check core/shared files avoid `console.*`, `process.exit`, `process.argv`,
     chalk/colors, Commander types, and MCP SDK types.
   - Violation: `src\client.ts`, `src\job-input.ts`, `src\schemas\job.ts`, or
     `src\daemon\store.ts` rendering terminal output or importing MCP types.
   - Fix: core returns data or throws typed errors; shims render CLI/MCP output.

5. **Per-job state/JSON schema files are always produced by the core.**
   - Check schema files/resources and persisted job JSON come from `JobSchema` or
     core storage/export logic.
   - Violation: `src\mcp\index.ts` hand-building a job JSON schema resource or
     `src\cli\index.ts` serializing a different import/export job shape.
   - Fix: generate from `src\schemas\job.ts` or delegate to core/daemon export;
     test that schedule/action schema shapes are present.

6. **Single source of truth for types and schemas.**
   - Check shims import core schemas/types instead of redeclaring them.
   - Violation: a new `z.enum(['cron','interval','one-shot'])` or prompt-engine
     enum in `src\mcp\index.ts` that can drift from `ScheduleSchema` or
     `PromptEngineSchema`.
   - Fix: export/import the authoritative schema/type from `src\schemas\job.ts`
     or a shared schema module.

7. **Errors must be actionable.**
   - Check core errors include what went wrong and what to do next.
   - Violation: `throw new Error('failed')`, raw daemon fetch errors, or CLI-only
     validation text that MCP cannot render consistently.
   - Fix: throw `CrontickError` or equivalent with `code`, clear message, and
     useful `details`; shims convert that to stderr/JSON/MCP content.

8. **Keep it lightweight.**
   - Check new exports, dependencies, files, and code paths are used and tested
     now.
   - Violation: unused dependencies in `package.json`, dead exports from
     `src\index.ts`, speculative config fields, or helper files not imported by
     production code/tests.
   - Fix: delete them, or connect them to current behavior with tests and docs.

## Drift check procedure

Enumerate the three public surfaces:

```powershell
rg -n "\.command\(" src\cli\index.ts
node -e "const fs=require('fs');const s=fs.readFileSync('src\\cli\\index.ts','utf8');for(const m of s.matchAll(/\.command\('([^']+)/g)) console.log(m[1]);"
rg -n "server\.registerTool\(" src\mcp\index.ts -A 2
node -e "const fs=require('fs');const s=fs.readFileSync('src\\mcp\\index.ts','utf8');for(const m of s.matchAll(/registerTool\(\s*\n\s*'([^']+)/g)) console.log(m[1]);"
rg -n "async [A-Za-z0-9_]+\(" src\client.ts
node -e "const fs=require('fs');const s=fs.readFileSync('src\\client.ts','utf8');for(const m of s.matchAll(/async ([A-Za-z0-9_]+)\(/g)) if(!['baseUrl','request'].includes(m[1])) console.log(m[1]);"
```

Build a drift matrix for changed capabilities:

- Job CRUD: `new/list/get/enable/disable/delete/import/export` vs `crontick_job_*`
  / `crontick_import` / `crontick_export` vs
  `createJob/listJobs/getJob/updateJob/deleteJob/enableJob/disableJob/importJobs/exportJobs`.
- Runs/logs: `run-now/logs` vs `crontick_job_run_now`,
  `crontick_job_cancel_run`, `crontick_run_*` vs `runNow/getRun/listRuns/getLogs`.
- Schedules: `crontick_schedule_validate`, `crontick_schedule_preview` vs
  `validateSchedule()`, `previewSchedule()`; add CLI only if humans need it.
- Daemon/dashboard/doctor: CLI `daemon *`, `dashboard`, `doctor`, `mcp` vs MCP
  `crontick_daemon_*`, `crontick_dashboard_open`, `crontick_doctor` vs client
  lifecycle methods.

For each changed capability, mark CLI, MCP, and client as **present**,
**not applicable**, or **drifted**, and cite `file:line`.

## Verification commands

Use the real package scripts:

```powershell
npm run typecheck
npm run lint
npm run build
npm test
```

Docs-only diffs do not need all commands. Code changes should at least run
`npm run typecheck` and targeted tests; use full `npm test` when scheduling,
daemon, schema, or surface parity changed.

## Severity guidance

- **P0**: business logic in a shim; surface drift; core importing transport
  concerns; per-job state or JSON schema not generated by core.
- **P1**: duplicated core logic; inconsistent names, parameters, defaults, or
  semantics; non-actionable errors.
- **P2**: dead code, unused exports/dependencies, speculative features, or docs
  gaps caused by the change.

## Required output format

```markdown
## Verdict
PASS | PASS-WITH-NITS | FAIL

## Findings
| Severity | File:line | Rule | Required fix |
|---|---|---|---|
| P0/P1/P2 | src\path\file.ts:123 | Rule number + title | Concrete fix |

## Drift matrix
| Capability | Client/core | CLI | MCP | Status |
|---|---|---|---|---|
| create job | src\client.ts:41 createJob | src\cli\index.ts:165 new | src\mcp\index.ts:121 crontick_job_create | present/drifted/not applicable |

## Verification reviewed
- Commands inspected/run:
- Relevant results:
```

Cite every finding with `file:line`. If there are no findings, say "No
architecture findings." `PASS` means no required changes, `PASS-WITH-NITS` means
only P2 findings, and `FAIL` means any P0 or P1 finding.