---
status: draft
summary: SP04 - dashboard "+" create and per-row pencil edit via one modal form; daemon gets a normalize-and-trust path (shared module with the client) so browser saves get CLI-identical defaults, cwd check, alias autogen and folder trust; schedule-kind registry in JS for SP05/06/10.
date: 2026-10-07
---

# PRD: Dashboard job editor

Repo/branch: `/root/projects/crontick-wt-improvements`, `users/tejitpabari/crontick-improvements` · Depends on: SP03 (request guard on mutating routes, Settings modal pattern, rem scale from SP02), SP01 (`--dir` naming in labels, `resolveJobRef`) · Owns: `src/dashboard/{index.html,dashboard.js,dashboard.css}` (editor modal, "+", pencil), `src/job-prepare.ts` (new: normalize + folder trust shared by client and daemon), `src/client.ts` (createJob/updateJob delegate to it; trust helpers move out), `src/daemon/api.ts` (`POST /api/jobs`, `PUT /api/jobs/:id` opt-in prepare mode, `GET /api/jobs/editor-meta`), `src/job-input.ts` (null-clears in patch schema), `tests/unit/dashboard-*.test.ts` + new `dashboard-job-editor`/`api-job-prepare` tests, `docs/reference/` (dashboard/API notes), `docs/specs/` (dashboard section), changeset.

## TL;DR

Header "+" opens a modal form to create a job; a pencil per table row opens the same form prefilled. Every field the CLI can set is a control; enable/disable, delete, run-now stay in the table/drawer. The browser must not re-implement CLI rules, and today it cannot reuse them: the CLI builds a full `Job` client-side (`normalizeJobInput`, cwd check, trust) and the daemon route only validates the schema and fills the engine. So SP04 extracts that pipeline into `src/job-prepare.ts`, called by both the client and new daemon "prepare" routes the dashboard uses. Folder trust is an explicit checkbox surfaced from `TRUST_REQUIRED`. The schedule section is driven by a JS kind registry so SP05/06/10 add one entry each.

## Problem

| Fact | Evidence |
|---|---|
| CLI create runs `normalizeJobInput` (config defaults for overlap/retry, `INVALID_CWD` check, prompt runtime validation) then trust check, then POSTs a finished Job | [verified: client.ts:280-285; job-input.ts:178-200,570-573] |
| `POST /api/jobs` only does `JobSchema.safeParse`, `applyConfigDefaults` (engine only), alias autogen, schedule validate, envFile read. No cwd existence check, no trust check, no prompt-runtime validation | [verified: api.ts:103-150] |
| `PUT /api/jobs/:id` is `{...job, ...body}` shallow merge: a partial `action` replaces the whole action; no cwd-session rule; no trust | [verified: api.ts:192-196 vs job-input.ts:266-291 normalizeJobPatch] |
| Patch semantics: `undefined` = unchanged, so no surface can clear `timeoutSec`, `sessionId`, `description` | [verified: job-input.ts mergeDefinedFields:331-337] |
| Folder trust is client-side: `ensureFoldersTrusted` throws `TRUST_REQUIRED`; `trustFolder:true` trusts first. Only engines whose adapter has `isFolderTrusted/trustFolder` (Claude) | [verified: client.ts:691-727] |
| CLI does NOT expose `env` or `envFile` (`--job-env-file` removed, guarded by test) | [verified: cli-env-file-flag.test.ts; commonJobOptions has no env flag] |
| `/api/schedules/validate` takes a bare schedule; `/preview` takes `{schedule, n}` and 400s on invalid | [verified: api.ts:322-343] |
| Dashboard has drawer (details, run/enable/disable), log modal, `window.confirm` for destructive actions; no form controls, no POST/PUT with body | [verified: dashboard.js:368-385,397-480] |

## Goals / Non-Goals

**Goals:** create and edit from the browser with CLI-identical validation and defaults; one normalization implementation; inline server errors; trust handled safely.
**Non-Goals:** editing `env`/`envFile` (not CLI-settable; preserved untouched on edit); prompt-file picker (CLI `--prompt-file` N/A, textarea only); `--file` JSON import; enable/disable/delete/run-now inside the editor; the request guard itself (SP03); new schedule kinds (SP05/06/10); duplicating a job.

## Requirements

### Field parity (every `commonJobOptions` flag)

| CLI option | Form control | Create | Edit |
|---|---|---|---|
| `-a, --alias` | text, kebab-case pattern hint | optional, placeholder "auto-generated" | prefilled; rename allowed; blank not allowed |
| `-p, --prompt` / `--prompt-file` | textarea (file option N/A) | required | prefilled |
| `--cron` / `--every` / `--at` | schedule kind select + per-kind inputs (registry) | required | prefilled by `schedule.kind` |
| `--dir` (SP01) | text input, label "Directory" | **required**, no default | prefilled from `action.cwd` |
| `--trust-folder` | checkbox, shown only after `TRUST_REQUIRED` | n/a until needed | same |
| `--runner` | select from engine names in `editor-meta` | defaults to `defaultEngine` | prefilled |
| trailing engine args / `--` | args rows (add/remove, ordered, one string each) | optional | prefilled |
| `--session-id` | text | optional | prefilled; clearing = clear |
| `--reuse-session` | checkbox | optional | prefilled |
| `--timeout` | number (sec), blank = unbounded | optional | blank clears |
| `--overlap` | select skip/queue/cancel-previous | preselected to effective default | prefilled |
| `--retry` | number `retry.max`; plus `backoffSec` number under an "advanced" disclosure (schema field, API-settable; CLI cannot) | defaults from config | prefilled |
| `--desc` | text | optional | prefilled; clearing = clear |
| `--enable/--disable`, `--force`, `--file` | not in form (enable/disable stays in table; `--force` N/A) | new job created enabled | unchanged |

Mutual exclusion rules the form enforces mirror the server: explicit `sessionId` implies reuse (disable the reuse checkbox when session id is filled, like `job-input.ts` clearing `reuseSession`); changing dir on a job with a session shows the `CWD_CHANGE_BREAKS_SESSION` guidance inline (server remains source of truth).

### Schedule section

- Kind select + panel are driven by `SCHEDULE_KINDS` in `dashboard.js`: `{ kind, label, fields[], toSchedule(values), fromSchedule(schedule), validate? }`. Initial entries: `cron` (expression), `interval` (number + s/m/h/d unit select, converted to `everySec`; optional `startAt`), `one-shot` (`datetime-local` -> ISO `runAt`). SP05 `after`, SP06 `webhook`, SP10 catch-up checkbox each add one registry entry/field descriptor; no change to the form shell.
- Live feedback: debounced (400 ms) `POST /api/schedules/preview` `{schedule, n:5}`; render the next fire times (local TZ) or the inline error. `validate` is called on blur for the cheap kind-specific message. Preview failure never blocks typing; Save is the authority.

### Business logic location (decision D1)

New `src/job-prepare.ts` exports `prepareCreate(input, {env, cwd, trustFolder})` and `prepareUpdate(existing, patch, {env, trustFolder})`: these wrap `normalizeJobInput` / `normalizeJobPatch` plus the trust logic extracted from `CrontickClient` (`trustTarget`, `ensureFoldersTrusted`). The client calls them (behavior unchanged for CLI/MCP/library). The daemon calls the same functions when the request opts in:

- `POST /api/jobs?prepare=1[&trustFolder=1]` body = `JobCreateInput` (no `id`, optional alias, `action.cwd` required). Runs `prepareCreate`, then the existing alias autogen/collision/persist path.
- `PUT /api/jobs/:id?prepare=1[&trustFolder=1]` body = `JobPatchInput`. Runs `prepareUpdate(existing, patch)` (field-wise merge, cwd-session rule) instead of the shallow spread.
- Without `prepare=1` both routes behave exactly as today (client path posts finished Jobs).
- `GET /api/jobs/editor-meta` -> `{ engines: [{name, type, supportsTrust}], defaultEngine, defaults: {overlap, timeoutSec?, retry}, aliasPattern }` from `loadConfig`, so the form never hardcodes defaults.
- No logic in JS beyond building the JSON body; all errors are `CrontickError` JSON from `sendError`.

### Clearing optional fields (D2)

`JobPatchInputSchema`/`PromptActionPatchSchema` accept `null` for `timeoutSec`, `sessionId`, `description` meaning "remove"; `mergeActionPatch` deletes keys whose patch value is `null`. Library/MCP gain this too (documented in `docs/reference/`), so no surface drift; CLI gets no new flag (non-goal) and `surface-drift` is unaffected because no capability is added. `cwd`, `engine`, `prompt`, `alias`, `schedule` are required-ish and cannot be nulled.

### Folder trust (D3)

CLI: `TRUST_REQUIRED` -> interactive prompt (`withTrustPrompt`) or `--trust-folder`. Dashboard: on 400/`TRUST_REQUIRED` the modal stays open, reveals a checkbox "Trust this folder in Claude: `<details.folders[0]>`" (explanation: lets Claude run there without asking), unchecked by default; Save re-sends with `trustFolder=1`. Trust is never auto-granted and only shown for engines whose adapter supports it (`supportsTrust` from meta). Changing engine/dir re-hides the checkbox. Only the trust-key-changed rule applies on edit (same as `updateJob`).

### UX

- Modal (reuses `.modal-backdrop` and SP03's modal conventions/rem sizes), not the drawer: drawer stays read-only details. Header "+" button next to SP03's gear; pencil button added as a leading action in each table row and in the drawer header (opens the same editor).
- Footer: **Save** and **Cancel**. Esc, backdrop click, and X when dirty -> `window.confirm('Discard unsaved changes? Changes will be lost.')` (same string/pattern as SP03). Clean -> closes immediately. Save enabled whenever the form is syntactically complete; required: prompt, schedule inputs, dir (create).
- Errors: server `message` in a banner at modal top; `details` (zod `format()` paths, `details.cwd`) mapped to field outlines where a path matches; modal stays open, nothing lost. Codes handled specially: `INVALID_CWD`, `JOB_ALREADY_EXISTS` (alias), `CWD_CHANGE_BREAKS_SESSION`, `TRUST_REQUIRED`, `VALIDATION_ERROR`.
- Success: close modal, toast, call the existing refresh (`/api/dashboard`); if the drawer shows that job it re-renders (existing `drawerJobId` refresh).
- All fetches send `Content-Type: application/json` (required by SP03's guard). Form sizes in rem only.
- Edit loads the job via `GET /api/jobs/:id` (not the table row copy) so stale-table edits do not clobber; edit sends only changed fields (diff vs loaded job), so untouched fields (incl. `env`, `envFile`, `retry.backoffSec`) are never rewritten.
- Accessibility: labeled inputs, focus trap, focus returns to the opener, banner `role="alert"`.

## Architecture

```
Dashboard form ──JSON (JobCreateInput|Patch, ?prepare=1[&trustFolder=1])──► api.ts
                                                                              │
CLI / MCP / library ─► client.createJob ─► job-prepare.ts ◄──────────────────┘
                                          (normalize + trust, one impl)
                                              └► POST/PUT finished Job (unchanged contract)
```

`src/job-prepare.ts` is the only place composing normalize + trust. `client.ts` shrinks. Daemon already imports `job-input.ts` (api.ts:14), so no new boundary crossing; the trust adapters live in `src/engines/` (public to daemon). Dashboard JS never imports anything.

## Decisions

| # | Decision | Choice | Alternatives considered | Why |
|---|---|---|---|---|
| D1 | Where browser create/update logic lives | Shared `job-prepare.ts`, daemon routes opt in via `?prepare=1` | Re-implement in JS; change default `POST /api/jobs` to accept inputs; new `/api/jobs/normalize` that returns a Job for the browser to POST | One implementation (rule 7/9); opt-in keeps client contract and tests; normalize-then-POST is two round trips and races trust |
| D2 | Clearing fields on update | `null` = remove in the patch schema for 3 fields | PUT full replace from the form; sentinel strings | Reuses merge path; keeps parity across surfaces; no hidden data loss on partial forms |
| D3 | Trust UX | Reveal-on-`TRUST_REQUIRED` checkbox, default off | Always show checkbox; auto-trust; skip trust for dashboard | Mirrors CLI safety (explicit consent); engines without trust never see it |
| D4 | Container | Modal | Drawer reuse | Long form + sticky footer; consistent with SP03 |
| D5 | Dir on create | Required, empty by default | Prefill daemon cwd | Brief item 9: daemon cwd meaningless |
| D6 | Env/envFile | Not editable, preserved | Add key/value rows | Not CLI-settable (removed); parity is the scope |
| D7 | Schedule extensibility | JS `SCHEDULE_KINDS` registry | switch/case in render code | SP05/06/10 add an entry |
| D8 | Dirty-confirm | `window.confirm` same text as SP03 | custom dialog | Consistency, zero UI |
| D9 | Edit diff | Send changed fields only | Send full job | Avoids baking defaults / clobbering env |

## Manual steps

- Owner: eyeball modal at the rem scale (SP02) on a real browser; run one Claude-engine create against an untrusted dir to see the trust flow.

## Risks / Open Questions

- [RESOLVED: guard owned by SP03] **Guard dependency.** Editor POST/PUT can set `cwd`/`args` (arbitrary command args to a configured engine) and `--trust-folder`; relies on SP03's Host/Content-Type/Origin guard covering all mutating routes, not only `/api/config`. Confirm SP03 applies it globally (brief item 10). If not, SP04 must not ship.
- [OPEN-2] `prepare=1` flag vs making `POST /api/jobs` always normalize (client then stops pre-normalizing). Leaning flag (smaller blast radius); revisit after the client refactor lands.
- [OPEN-3] `null`-clears widen the public patch type (`JobPatchInput`): acceptable under no-backward-compat, but needs `docs/reference/library-api.md`, `mcp-tools.md` notes and tests; confirm owner wants it on MCP too or dashboard-only (a daemon-only patch variant would break the one-schema rule).
- [OPEN-4] Directory entry is free text; no browser file picker can return an absolute path. Is a daemon-backed path autocomplete (`GET /api/fs/dirs`) wanted? Leaning DEFERRED (new filesystem-reading endpoint).
- [RESOLVED-5: expose `retry.backoffSec` in the form under "advanced"]
- [RESOLVED-6: owner decision, confirm at Save not at Edit; stop vs wait] Editing a job with in-flight runs: on Save, user chooses (a) stop in-flight runs, then apply (daemon cancels them and applies in one request), or (b) wait for runs to complete, then apply: the job is paused (no new fires/queued starts for it), the change applies once its in-flight runs finish, then the job resumes automatically; or cancels the save. Stopped runs: status `canceled`, no retry, do not trigger `--after` dependents; queued runs for that job are dropped. Non-interactive: CLI prompts on a TTY else `--stop-running` / `--wait-running`; MCP/library `inFlight: 'stop' | 'wait'`; no choice with runs in flight = error listing them. Pause state and its surface parity are owned by SP03 (R16/R17); open follow-ups are SP03 OPEN-9..12.
- [RESOLVED-7: local timezone only; `datetime-local` value is interpreted as local time, same as `--at`; verify `runAt` parsing during implementation; no timezone selector]
- [RESOLVED-8: accepted, server error surfaced in the modal] Prompt textarea vs `Windows cmd-line length` validation (`promptRuntimeValidationMessage`) surfaces as server error only; acceptable.
- [DEFERRED] Duplicate-job action; env editing; path autocomplete.
- [RESOLVED: env/envFile] not CLI-exposed; preserved by diff-only edits.
- [RESOLVED: update merge] daemon `PUT` shallow merge is bypassed by prepare mode using `normalizeJobPatch`.

## Acceptance Criteria

- Every row of the parity table has a control; a test enumerates `commonJobOptions` flags (minus the excluded set) against form field ids so a new CLI flag fails until mapped.
- Create via `POST /api/jobs?prepare=1` applies config overlap/retry defaults, default engine, alias autogen, `INVALID_CWD` for missing dir, same result as `createJobFromCliOptions` (parametrized equivalence test).
- Update via `PUT ...?prepare=1` merges field-wise (changing only prompt keeps args, reuseSession, env); `null` clears `timeoutSec`/`sessionId`/`description`; cwd change with a session returns `CWD_CHANGE_BREAKS_SESSION`.
- Untrusted dir with Claude engine returns `TRUST_REQUIRED` (details.folders); retry with `trustFolder=1` trusts and creates; non-trust engines never return it.
- `client.createJob/updateJob` unchanged in behavior (existing tests pass) while trust/normalize code exists once in `job-prepare.ts`.
- Dashboard asset tests: "+" button, per-row pencil, editor modal, registry (`SCHEDULE_KINDS`), no px font sizes, all fetches set `Content-Type: application/json`; dirty-cancel uses the SP03 confirm string. Jsdom or string-level tests for body building (form values -> JSON) if a DOM harness is available [OPEN: current dashboard tests are string/HTTP only].
- Manual/screenshot: create a cron job, edit it to every-30m, see preview; server error banner keeps edits; enable/disable/delete/run-now unchanged.
- Docs: `docs/reference/` job editor/API routes + null-clear, spec dashboard section, changeset; `npm run validate` green; `surface-drift` green (no new capability).
