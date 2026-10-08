---
status: draft
summary: SP01 CLI polish - exact schedule help + footer, -C/--cwd becomes --dir, one shared job id-or-alias resolver, new `runs delete` across client/CLI/MCP/API.
date: 2026-10-07
---

# PRD: SP01 CLI polish

Repo/branch: `/root/projects/crontick-wt-improvements`, `users/tejitpabari/crontick-improvements` · Depends on: none · Owns: `src/cli/index.ts` (commonJobOptions, `runs`), `src/cli/confirm.ts` (new), `src/utils/job-ref.ts` (new), `src/constants/schedule-flags.ts` (new), `src/surface.ts`, `src/client.ts` (deleteRuns), `src/mcp/index.ts` (+1 tool), `src/daemon/api.ts` (runs route, resolver call sites), `src/daemon/store.ts` (getJob delegate, deleteRuns), `docs/reference/{cli,mcp-tools,library-api}.md`, changeset

## TL;DR

Four changes. (1) Schedule flag help uses the brief's exact strings; `jobs new` gets a "How to schedule" footer built from a constant list so SP05/SP06 append one entry. (2) `-C, --cwd <dir>` becomes `--dir <path>` (no short flag); stored field, MCP and `--file` keep `cwd`. (3) Id-or-alias lookup moves into one pure function that `Store.getJob` and the new runs-delete path both call; audit shows every route already resolves alias, so this is consolidation, not a behavior fix. (4) `runs delete <runId...> | --job <id|alias>` with dry-run-backed confirm, active-run skip, orphan-safe cleanup.

## Problem

| Fact | Evidence |
|---|---|
| Resolution works everywhere, but lives in `Store.getJob` plus an ad-hoc `?.id ?? requested` in `runFilterParams` | [verified: grep 'getJob' src/daemon/api.ts → 177-211 jobMatch, 355 stats, 430-437 export, 539 runFilterParams] |
| Client and MCP never resolve; they forward the raw string, the daemon resolves | [verified: client.ts 300-345,450 `encodeURIComponent(id)`; mcp getJob passes `args.id`] |
| --cron/--every/--at help carries a "(exactly one of ...)" prefix; no footer | [verified: cli/index.ts:212-217] |
| `-C, --cwd` appears in CLI, docs, SKILL.md, README, tests | [verified: grep → docs/reference/cli.md:81,93,125,300; README.md:156; docs/examples/cli/README.md:29; src/skill/SKILL.md:39,105; tests/unit/job-cwd.test.ts, claude-trust-flow.test.ts; docs/concepts/jobs.md; docs/specs/007] |
| No way to delete runs; `deleteJobAndRuns` only works for an existing job | [verified: store.ts:350-376; cli/index.ts:500-545] |
| `runs.job_id` has no FK, so orphans exist | [verified: store.ts:165-168] |
| GUID-shaped strings satisfy `JOB_ALIAS_PATTERN`; id is tried first so such an alias would be shadowed | [verified: schemas/job.ts:92; api.ts:120,202 reject alias equal to an existing id/alias] |
| `jobs delete all` is a reserved keyword; alias `all` is not rejected | [verified: cli/index.ts:486; grep "'all'" src/job-input.ts → 0 matches] |

## Goals / Non-Goals

**Goals:** brief items 4, 5, 6, shared resolver; surface parity; tests + docs per change.
**Non-Goals:** dashboard run delete; `--after`/`--webhook` flags and their footer text (SP05/06); config/port work (SP02/03); renaming the `cwd` field; keeping `-C`/`--cwd` as an alias.

## Requirements

| # | Requirement |
|---|---|
| R1 | `--cron` "Schedule: cron expression, e.g. \"0 9 * * *\""; `--every` "Schedule: repeat every N seconds, or use an s/m/h/d suffix (e.g. 30m)"; `--at` "Schedule: one-shot run time, ISO-8601 (e.g. 2026-10-01T09:00)". In `commonJobOptions`, so also on `jobs update`. |
| R2 | `jobs new` only: `addHelpText('after')` footer "How to schedule": "use exactly one of <flags>" (this SP: `--cron, --every, --at`). `jobs update --help` has no footer. |
| R3 | `--dir <path>` (long option only, no `-d` short flag) "Directory the job runs in (default: current directory)" replaces `-C, --cwd`. `-C`/`--cwd` become unknown options, including after `--` (update the crontick-flag rejection list in `splitPromptEngineArgs`). `-d` is not a crontick flag; it is never consumed (after `--` it passes to the engine as usual). |
| R4 | One `resolveJobRef`; `Store.getJob` delegates; `runFilterParams`, export `onlyJobs`, `runs delete --job` all call it. No other lookup code remains. |
| R5 | Alias `all` rejected in create/update/import validation (reserved by `jobs delete all`). |
| R6 | `runs delete` on client, CLI, MCP, API, `SURFACE_CAPABILITIES` (`delete-runs`). |

### Reference audit (every job-reference input)

| Input | Accepts alias today | Change |
|---|---|---|
| `jobs get/update/delete/enable/disable/run-now/schedule` (`/api/jobs/:id*`) | yes, daemon `getJob` | none (flows through resolver) |
| `stats job` (`/api/stats/jobs/:id`) | yes | none |
| `runs list --job` / `?jobId=` (also dashboard filters) | yes; unknown ref falls through as raw id (intentional, orphans) | call `resolveJobRef` |
| `share export --only-jobs` | yes; misses → `JOB_NOT_FOUND` | call `resolveJobRef` |
| `runs get/cancel` | run ids only | n/a |
| `runs delete --job` | new | resolver, fallback to raw id |
| MCP tools with `id` | yes (pass-through) | wording only |
| Dashboard | no job-ref input | none |

### `runs delete` semantics

- Input: `runIds` (1+) XOR `job` (id|alias); neither or both → `VALIDATION_ERROR`.
- `--job X`: `resolveJobRef(X)?.id ?? X` (orphan fallback); selects all runs with that `job_id`; works when the job is gone.
- `queued`/`running` runs are skipped (not cancelled) and reported.
- Deletes `run_outputs` then `runs` in one txn. If the target job no longer exists and no runs remain for it, unlinks its per-job log (`resolveJobLogPath`, reuse `removeJobLogFile`). A live job's log is untouched.
- Unknown run ids go to `notFound`; others still processed.
- Response (API/client/MCP/`--json`): `{ deleted: string[], skipped: [{id, status}], notFound: string[], jobLogRemoved: boolean }`. Plain CLI: `Deleted N run(s); skipped M active; not found K.`
- API: `DELETE /api/runs?runId=a,b` or `DELETE /api/runs?jobId=X`, optional `dryRun=1` (same shape, nothing deleted).
- CLI: `crontick runs delete <runId...>` | `--job <id|alias>`, `--force`, `--dry-run`. Without `--force`: dry run first, prompt `Delete N run(s)[ of job X]? (y/N)`. Non-TTY without `--force` → error `CONFIRMATION_REQUIRED`, exit 1. Prompt helper `src/cli/confirm.ts`, injectable TTY streams, modeled on `src/cli/trust-prompt.ts`.
- Client `deleteRuns({ runIds?, job?, dryRun? })`: no prompt.
- MCP `crontick_run_delete`: `{readOnlyHint:false, destructiveHint:true, idempotentHint:true, openWorldHint:false}`; description tells the agent to confirm with the user first and offers `dryRun`.

## Architecture

```ts
// src/utils/job-ref.ts (pure, no I/O)
export interface JobRefLookup<T> { byId(ref: string): T | undefined; byAlias(ref: string): T | undefined }
export function resolveJobRef<T>(ref: string, lookup: JobRefLookup<T>): T | undefined; // id first, then alias
export const RESERVED_JOB_REFS = ['all'] as const;
// src/constants/schedule-flags.ts
export const SCHEDULE_FLAGS = ['--cron', '--every', '--at'] as const; // SP05/06 append '--after', '--webhook'
```

- Resolution stays daemon-side; client/MCP/CLI keep forwarding raw refs. `Store.getJob` = `resolveJobRef(ref, {byId: getJobRowById, byAlias: getJobRowByAlias})`.
- `Store.deleteRuns({runIds | jobId, dryRun})` is new; `deleteJobAndRuns` unchanged. Route sits beside `GET /api/runs` in `api.ts`.
- Footer text is generated from `SCHEDULE_FLAGS`.
- Cross-SP interface assumptions: SP05/SP06 only append to `SCHEDULE_FLAGS`, add their option to `commonJobOptions`, and call `resolveJobRef` (no new lookup code). SP04's dashboard editor keeps sending `cwd` in job JSON. SP03 also edits `src/cli/index.ts`, `client.ts`, `mcp/index.ts`, `surface.ts`; SP01 runs first and its edits are additive.

## Decisions

| # | Decision | Choice | Alternatives considered | Why |
|---|---|---|---|---|
| D1 | MCP/library working-dir name | stays `cwd` (inside `action`); only the CLI flag is `--dir` | rename to `dir` everywhere | Brief item 5; `cwd` is the persisted field and what docs/MCP describe; flag is presentation only |
| D2 | Resolver location | pure fn in `src/utils/job-ref.ts`, called daemon-side | client-side resolve; leave in Store | Rule 9 (reusable logic in utils); client-side adds a round trip and races |
| D3 | Alias vs raw-id collision | id wins (existing order); create/update already reject alias equal to a live id/alias | alias wins; ambiguity error | Immutable GUID is the PK; collision unreachable via API |
| D4 | Reserve alias `all` | reject in validation | turn `all` into an `--all` flag | Keeps existing `jobs delete all` UX; one-line guard |
| D5 | Runs-delete route | `DELETE /api/runs?runId=\|jobId=` + `dryRun` | `DELETE /api/runs/:id` plus a job route; POST body | One shape for both modes; dry run gives accurate confirm counts |
| D6 | Active runs | skip and report | cancel then delete; error out | Brief item 6; avoids racing the runner |
| D7 | Confirm placement | CLI prompt + `--force`; non-TTY requires `--force` | client `force` flag like `deleteJob all` | Deleting named/filtered runs is not a wipe-all; MCP agents are guided by description |
| D8 | Footer contents | cron/every/at only, constant-driven | hardcode the brief's 5-kind string | Must not name flags that do not exist yet |
| D9 | Exit code on unknown run ids | exit 1 if any `notFound`, output still printed | always 0 | Scriptable, like `rm` |

## Risks / Open Questions

- [RESOLVED: owner decision] A live job's per-job log file is append-only and shared, so lines tagged with deleted run ids remain. `runs delete` leaves them; no documentation needed, no file rewrite.
- [RESOLVED-2: no `-d` short flag at all; only `--dir` long option replaces `-C, --cwd`, so no clash with any future global `-d`]
- [RESOLVED-3: single txn, bounded by `retention.maxRunsPerJob`; revisit if slow]
- [RESOLVED: id wins on collision (D3)]
- [RESOLVED: GUID-shaped alias already rejected on create/update, api.ts 120/202]
- [DEFERRED] Dashboard run delete (brief non-goal).

## Acceptance Criteria

- `jobs new --help` shows the three exact strings plus a "How to schedule" footer listing `--cron, --every, --at`; `jobs update --help` has the same strings and no footer; a test derives the footer from `SCHEDULE_FLAGS`.
- `--dir` works on new/update (default = invoking dir, `INVALID_CWD`, trust flow); `-C`/`--cwd` error as unknown options; tests (`job-cwd`, `cli-job-options`, `claude-trust-flow`), README, SKILL.md, `docs/reference/cli.md`, `docs/examples/cli/README.md`, concepts/specs updated; stored field and MCP stay `cwd`.
- Grep finds exactly one id/alias lookup implementation (`resolveJobRef`); a parametrized test hits each route in the audit table by alias and by id; alias `all` rejected.
- `runs delete` works by ids, by `--job` alias, and by `--job` raw id of a deleted job (orphan); active runs skipped and listed; `run_outputs` gone; orphan job log removed, live job log kept; `--dry-run` and confirm counts correct; non-TTY without `--force` fails; `--force` deletes.
- `surface-drift` green with `delete-runs` (`deleteRuns`, `['runs','delete']`, `crontick_run_delete`); `docs/reference/{cli,mcp-tools,library-api}.md` updated; changeset added; `npm run validate` passes.
