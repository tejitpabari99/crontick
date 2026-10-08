---
status: draft
summary: Six tasks - exact schedule help + footer, --dir flag replacing -C/--cwd, shared job-ref resolver, runs delete core (store/API/client), runs delete CLI/MCP/surface, tests/docs/changeset.
date: 2026-10-08
---
# Tasks: SP01 CLI polish
Source of truth: docs/agent_files/users-tejitpabari-crontick-improvements-20261007-0034/01-cli-polish/PRD.md. All PRD Risks are [RESOLVED] or [DEFERRED]; no [OPEN] items. SP01 runs first; its edits to shared files (CLI, client, MCP, surface) are additive so SP03 can follow. No new runtime dependencies.

| # | Task | Depends on | Status |
|---|---|---|---|
| 1 | Schedule flag help and "How to schedule" footer | - | todo |
| 2 | Replace `-C, --cwd` with `--dir` | - | todo |
| 3 | Shared `resolveJobRef` and reserved alias `all` | - | todo |
| 4 | `runs delete` core: store, API route, client | 3 | todo |
| 5 | `runs delete` CLI, confirm prompt, MCP tool, surface entry | 4 | todo |
| 6 | Tests, docs, reference, changeset | 1-5 | todo |

## Task 1 — Schedule flag help and "How to schedule" footer
What it is / what it means: The `--cron`, `--every`, `--at` help text should use the brief's exact wording, and `jobs new` should explain the one-of rule in a footer (R1, R2, D8).
What changes at a high level: Add a schedule-flags constant list (cron, every, at) in the constants area, designed so SP05/SP06 only append entries. Reword the three options in the shared job-options set (so `jobs update` gets the same strings) and drop the "(exactly one of ...)" prefix. Attach an after-help "How to schedule" footer to `jobs new` only, generated from the constant; `jobs update --help` gets no footer. Do not name flags that do not exist yet.
Done when: `jobs new --help` shows the three exact strings plus a footer listing `--cron, --every, --at`; `jobs update --help` has the strings and no footer; a test derives the expected footer from the constant.

## Task 2 — Replace `-C, --cwd` with `--dir`
What it is / what it means: The CLI working-directory flag becomes a long-only `--dir <path>`; the stored field, MCP and `--file` input keep the name `cwd` (R3, D1).
What changes at a high level: In the shared job-options set, replace `-C, --cwd` with `--dir <path>` ("Directory the job runs in (default: current directory)"), mapped to the existing cwd behavior (default invoking dir, `INVALID_CWD`, trust flow). Make `-C`/`--cwd` unknown options everywhere, including after `--`, by updating the crontick-flag rejection list in the prompt/engine arg splitter; `-d` is never consumed and passes to the engine after `--`. Update existing tests that use the old flag, plus README, skill doc, CLI reference, CLI examples, concepts and spec text that mention it.
Done when: `--dir` works on `jobs new/update`; `-C`/`--cwd` fail as unknown options (also after `--`); renamed-flag tests pass; no stale `-C/--cwd` mentions remain in docs; stored field and MCP still `cwd`.

## Task 3 — Shared `resolveJobRef` and reserved alias `all`
What it is / what it means: Id-or-alias lookup consolidates into one pure function; behavior is unchanged except `all` becomes a reserved alias (R4, R5, D2, D3, D4).
What changes at a high level: Add a pure resolver in utils (id first, then alias, via an injected lookup) and a reserved-refs constant containing `all`. Make the store's job lookup delegate to it, and route the runs-filter job param and the share-export only-jobs filter through it (runs filter keeps the raw-id fallback for orphans; export keeps `JOB_NOT_FOUND` on a miss). Reject alias `all` in create, update and import validation. Daemon-side resolution stays; client/MCP/CLI keep forwarding raw refs.
Done when: Only one id/alias lookup implementation remains; a parametrized test hits each audit-table route by alias and by id; alias `all` is rejected on create, update and import.

## Task 4 — `runs delete` core: store, API route, client
What it is / what it means: A new way to delete runs by id or by job, safe for active runs and orphans (R6, D5, D6).
What changes at a high level: Add a store operation taking run ids XOR a job id, plus a dry-run flag. Job refs resolve via the resolver with fallback to the raw id so deleted jobs work. Queued/running runs are skipped and reported; unknown ids go to `notFound`; output rows then run rows are removed in one transaction. If the job is gone and no runs remain, remove its per-job log via the existing helper; a live job's log is untouched. Add `DELETE /api/runs` (`runId` list or `jobId`, optional `dryRun`) beside the runs list route, returning the specified result shape; neither or both inputs gives `VALIDATION_ERROR`. Add a client `deleteRuns` method with no prompt.
Done when: Tests cover ids, job alias, raw id of a deleted job, active-run skip, output cleanup, orphan log removal vs live log kept, dry-run, and validation errors.

## Task 5 — `runs delete` CLI, confirm prompt, MCP tool, surface entry
What it is / what it means: Expose the new capability on the remaining surfaces with the confirmation policy (D7, D9, R6).
What changes at a high level: Add an injectable confirm prompt helper modeled on the existing trust prompt. Add `crontick runs delete <runId...> | --job <id|alias>` with `--force` and `--dry-run`: without `--force`, run a dry run, show counts, prompt; non-TTY without `--force` errors `CONFIRMATION_REQUIRED` (exit 1). Plain output `Deleted N run(s); skipped M active; not found K.`; `--json` prints the full result; exit 1 if any run id was not found. Add MCP tool `crontick_run_delete` with destructive/idempotent hints and a description telling agents to confirm first and offering dryRun. Add the `delete-runs` capability entry linking client method, CLI path and MCP tool. CLI and MCP stay thin shims.
Done when: Surface-drift test is green; CLI tests cover prompt yes/no, non-TTY failure, `--force`, `--dry-run`, JSON output, not-found exit code; MCP tool test passes.

## Task 6 — Tests, docs, reference, changeset
What it is / what it means: Close out per AGENTS.md testing, documentation and release rules.
What changes at a high level: Fill remaining test gaps from the acceptance criteria. Update `docs/reference/` (CLI, MCP tools, library API) for `--dir`, schedule help/footer, `runs delete`, `crontick_run_delete` and `deleteRuns`; update the relevant specs and concepts; note the resolver and reserved alias in implementation docs. Add a changeset (minor, pre-1.0) calling out the `-C/--cwd` removal as a breaking CLI change. Run `npm run validate`.
Done when: `npm run validate` passes, docs and reference match behavior, and a changeset exists.

## Manual steps
None in the PRD. Dashboard run delete is deferred (brief non-goal); `--after`/`--webhook` flags and footer entries belong to SP05/SP06.
