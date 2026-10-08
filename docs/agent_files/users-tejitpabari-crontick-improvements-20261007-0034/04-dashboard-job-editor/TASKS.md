---
status: draft
summary: Eight tasks - shared job-prepare module, null-clears + CLI --unset, daemon prepare routes + editor-meta, in-flight-run handling on update, editor modal shell, schedule registry + preview, error/trust/in-flight UX, tests/docs/changeset.
date: 2026-10-08
---
# Tasks: SP04 Dashboard job editor
Source of truth: docs/agent_files/users-tejitpabari-crontick-improvements-20261007-0034/04-dashboard-job-editor/PRD.md. All PRD Risks are [RESOLVED] or [DEFERRED]; the one literal "[OPEN" in the acceptance criteria is a test-harness note inside a criterion, not an open item (handled in Task 8 as string-level tests, DOM harness only if one already exists). Depends on SP03 (request guard on all mutating routes, Settings modal pattern, pause state for in-flight "wait") and SP01 (`--dir`, `resolveJobRef`); SP02 rem scale. No new runtime dependencies.

| # | Task | Depends on | Status |
|---|---|---|---|
| 1 | Extract `job-prepare.ts` (normalize + folder trust) | - | todo |
| 2 | Null-clears in patch schema and CLI `--unset` | - | todo |
| 3 | Daemon prepare mode routes and `editor-meta` | 1, 2 | todo |
| 4 | In-flight run handling on update (stop / wait) | 3 | todo |
| 5 | Editor modal shell, "+" and pencil, field parity | 3 | todo |
| 6 | Schedule kind registry and live preview | 5 | todo |
| 7 | Error mapping, trust reveal, in-flight choice, success flow | 4, 5, 6 | todo |
| 8 | Tests, docs, reference, changeset | 1-7 | todo |

## Task 1 — Extract `job-prepare.ts` (normalize + folder trust)
What it is / what it means: One shared implementation of "input to finished Job" used by the client and the daemon (D1, Business logic location).
What changes at a high level: Add a new module exporting `prepareCreate` and `prepareUpdate`, wrapping `normalizeJobInput` / `normalizeJobPatch` plus the trust logic moved out of `CrontickClient` (trust target, ensure-folders-trusted). Both take an injected `resolveJob(idOrAlias)` that SP04 itself does not use (SP05 `after` will). Client createJob/updateJob delegate to it; trust helpers leave the client. CLI, MCP and library behavior is unchanged.
Done when: Trust and normalize code exists once; all existing client, CLI and MCP tests pass untouched; the module is internal (not exported from the public index).

## Task 2 — Null-clears in patch schema and CLI `--unset`
What it is / what it means: Today no surface can clear `timeoutSec`, `sessionId` or `description`; `null` now means "remove" everywhere via the single shared schema (D2, RESOLVED-3).
What changes at a high level: The patch schemas accept `null` for those three fields only; the action-patch merge deletes keys whose patch value is `null`; `cwd`, `engine`, `prompt`, `alias`, `schedule` cannot be nulled. Library and MCP gain this through the schema, no new capability. Add `jobs update <job> --unset <field>` (repeatable and/or comma-separated; `timeout`, `session-id`, `desc`) as a thin shim mapping to `null`. Unknown field, or `--unset X` alongside the setter flag for X, is a usage error.
Done when: Library, MCP and CLI tests show each field clears; usage errors covered; `surface-drift` stays green.

## Task 3 — Daemon prepare mode routes and `editor-meta`
What it is / what it means: The browser gets CLI-identical defaults, cwd check, alias autogen, field-wise merge and trust through the daemon (D1, D3, D5).
What changes at a high level: `POST /api/jobs?prepare=1[&trustFolder=1]` takes a create input (no id, optional alias, `action.cwd` required), runs `prepareCreate`, then the existing alias autogen/collision/persist path. `PUT /api/jobs/:id?prepare=1[&trustFolder=1]` takes a patch and runs `prepareUpdate` instead of the shallow spread. Without the flag both routes behave exactly as today. Add `GET /api/jobs/editor-meta` returning engines (name, type, supportsTrust), default engine, effective defaults (overlap, timeout, retry) and the alias pattern, read from config. Errors stay `CrontickError` JSON. Relies on SP03's guard covering these routes.
Done when: Prepare-mode create matches `createJobFromCliOptions` (parametrized equivalence); update merges field-wise and honors the cwd-session rule; untrusted Claude dir returns `TRUST_REQUIRED` with folders and succeeds with `trustFolder=1`; non-trust engines never return it; default-mode route tests unchanged.

## Task 4 — In-flight run handling on update (stop / wait)
What it is / what it means: Saving an edit to a job with runs in flight needs an explicit choice, decided at Save (RESOLVED-6).
What changes at a high level: Update gains an in-flight option, `stop` or `wait`. Stop: the daemon cancels the job's in-flight runs (status `canceled`, no retry, no `--after` dependents triggered), drops its queued runs, and applies the change in one request. Wait: the job is paused via SP03's pause state, the change applies once in-flight runs finish, then the job resumes automatically. With runs in flight and no choice, return an error listing them. Surfaces: library/MCP `inFlight: 'stop' | 'wait'`; CLI `--stop-running` / `--wait-running`, plus a TTY prompt when neither is given, else the error. Shims stay thin; pause state parity is owned by SP03.
Done when: Tests cover stop, wait (apply after completion, auto-resume), missing-choice error with run list, and each surface; queued runs dropped and canceled runs do not retry.

## Task 5 — Editor modal shell, "+" and pencil, field parity
What it is / what it means: The form container and every non-schedule control from the parity table (D4, D5, D6, D8, D9; Field parity, UX).
What changes at a high level: Header "+" next to SP03's gear, a pencil in each table row and the drawer header, one modal reusing `.modal-backdrop` and SP03 conventions, rem sizes only. Controls for alias, prompt, directory (required on create, no default, label "Directory"), runner (from `editor-meta`, defaults to default engine), ordered args rows, session id, reuse-session (disabled while session id filled), timeout (blank clears), overlap, retry max plus `backoffSec` under an "advanced" disclosure, description. Edit loads the job via `GET /api/jobs/:id`, sends only changed fields (blank cleared fields become `null`), and never touches `env`/`envFile`. Dirty close (Esc, backdrop, X) uses the SP03 `window.confirm` string. Labeled inputs, focus trap, focus returns to opener. All fetches send `Content-Type: application/json`.
Done when: Every parity-table row has a control; create posts to prepare mode; edit sends a diff only; dirty-cancel and accessibility behaviors present.

## Task 6 — Schedule kind registry and live preview
What it is / what it means: A JS-driven schedule section so later sub-projects add one entry each (D7, RESOLVED-7).
What changes at a high level: A `SCHEDULE_KINDS` registry of kind, label, fields, to/from schedule conversion and optional validate. Initial entries: cron expression; interval (number plus s/m/h/d unit converted to `everySec`, optional start); one-shot (`datetime-local` as local-time ISO `runAt`, same as `--at`; verify parsing). Edit prefills by `schedule.kind`. Debounced (400 ms) `POST /api/schedules/preview` with 5 fires renders next times in local TZ or an inline error; validate runs on blur; preview failure never blocks typing. No timezone selector.
Done when: Registry drives the select and panels with no per-kind branching in the form shell; preview and blur messages render; a cron job can be edited to every-30m with preview.

## Task 7 — Error mapping, trust reveal, in-flight choice, success flow
What it is / what it means: Server errors and safety prompts surfaced in the modal without losing edits (D3, RESOLVED-6, RESOLVED-8).
What changes at a high level: Banner (`role="alert"`) shows the server message; `details` paths map to field outlines. Special handling for `INVALID_CWD`, `JOB_ALREADY_EXISTS`, `CWD_CHANGE_BREAKS_SESSION`, `TRUST_REQUIRED`, `VALIDATION_ERROR`. On `TRUST_REQUIRED` reveal an unchecked "Trust this folder in Claude: <folder>" checkbox (only when `supportsTrust`), re-send with `trustFolder=1`, re-hide on engine or dir change. When the job has in-flight runs, Save offers stop, wait, or cancel before sending. Success closes the modal, toasts, refreshes the dashboard, re-renders an open drawer for that job. Prompt-length runtime errors appear as server errors only.
Done when: Each special code produces its UI state with edits retained; trust is never auto-granted; in-flight choice is sent as the option from Task 4.

## Task 8 — Tests, docs, reference, changeset
What it is / what it means: Close out per AGENTS.md and the PRD acceptance criteria.
What changes at a high level: A test enumerates `commonJobOptions` flags (minus the excluded set) against form field ids so new CLI flags fail until mapped. Dashboard asset tests (string/HTTP level): "+" button, row pencil, modal, `SCHEDULE_KINDS`, no px font sizes, JSON content-type on fetches, SP03 confirm string; body-building tests via a DOM harness only if one already exists. Fill gaps for prepare routes, null-clears, `--unset`, and in-flight handling. Update `docs/reference/` (CLI `--unset`, `--stop-running`/`--wait-running`, library-api and mcp-tools null-clear and `inFlight` notes, API routes and editor-meta), the dashboard spec section, and add a changeset. Run `npm run validate`.
Done when: `npm run validate` passes with `surface-drift` green, docs match behavior, changeset exists.

## Manual steps
Owner: eyeball the modal at the SP02 rem scale in a real browser; run one Claude-engine create against an untrusted directory to see the trust flow; screenshot check of create, edit to every-30m with preview, and error banner keeping edits. Deferred (out of scope): directory autocomplete, duplicate job, env editing.
