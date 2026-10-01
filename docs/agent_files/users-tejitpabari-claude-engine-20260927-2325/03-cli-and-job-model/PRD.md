---
status: draft
summary: SP03 CLI and job model (Phase 1) - alias as the one term, per-job cwd with Claude trust check, default config file, run-delete fix, share export/import schema v1, CLI/MCP surface cleanup.
date: 2026-10-01
---

# SP03 - CLI & Job Model

## TL;DR

Seventeen owner requests, one coherent change set. Core moves: (1) one user-facing term, **alias**, with `--name`/`-n` kept as the flag spelling; (2) a first-class per-job working directory (`--cwd`/`-C`, stored in `action.cwd`) with a Claude trust check in the client/engine adapter and a prompt only in the CLI; (3) `config.json` auto-created (never overwritten); (4) deleting a job deletes its runs/logs everywhere (root cause: single-job delete deliberately "archives" runs); (5) `runs logs`/`runs output` removed, folded into `runs get`; (6) `share export/import` become jobs-only with a validated `schema: 1` envelope; (7) `--tz` removed. All of it ships through the existing surface-parity chain (client, CLI, MCP, `SURFACE_CAPABILITIES`) with `jobs new`/`jobs update` kept in sync via `commonJobOptions`.

## Problem

Verified current state (paths relative to `src/`):

- `info` prints a "commands" list built from `INFO_GROUP_COMMANDS = {daemon, doctor}` and keeps hidden `info daemon`/`info doctor` duplicates `[cli/index.ts:615-661,715-717]`.
- `config.json` is never written automatically; `info` reports "not created yet" `[client.ts info(); initConfig is library-only, no CLI/daemon caller: grep]`. Users cannot discover/edit `defaults`.
- `jobs new` help repeats the schedule flags twice (Options list plus an `addHelpText` "Schedule:" block, with the timezone note and `--tz`) `[cli/index.ts:210-217,410-414]`.
- The user-facing term is mixed: JSON key/DB column/store API say `alias`; CLI flag, help, MCP descriptions, error text say "name" (`[mcp/index.ts: "(id or name)" x10; cli/index.ts]`). Every id-accepting route already resolves id-or-alias via `Store.getJob` `[store.ts:350-362; api.ts jobMatch, statsJobMatch, runFilterParams]`, so only labels are wrong.
- `generateAlias` already regenerates on collision (50 attempts, `isTaken` = `store.getJob`, covers id and alias) `[job-input.ts:192-209; api.ts:115]`, but has no fallback after exhaustion (throws `ALIAS_GENERATION_FAILED`) and a create race surfaces a raw UNIQUE-index error `[store.ts idx_jobs_alias]`.
- `action.cwd` exists in the schema and the runner validates it at spawn, but nothing sets it: the CLI never fills it, so the engine starts in the **daemon's** cwd (`action.cwd ?? process.cwd()` `[runner.ts:562]`).
- `Store.deleteJob` deletes only the `jobs` row; runs, run_logs and schedule state are left ("archives run history") `[store.ts:388-395]`. Dashboard/stats read `listRunsForExistingJobs` (INNER JOIN jobs) while `GET /api/runs` -> `listRuns` does not `[store.ts:645-725; api.ts:258-266]`. That is the entire "deleted job still in `runs list`" bug. Only `deleteAllJobs` purges runs `[store.ts:405-421]`.
- `stats job` returns raw epoch ms for `lastRunAt` and sums only the most recent 100 runs (`listRuns({limit:100})`, so `totalRuns` caps at 100) `[api.ts:354-366]`.
- Export is `{jobs, runs?}` with no version marker; import accepts a bare array or an object, upserts by existing id/alias, and restores runs `[client.ts:375-382; api.ts:419-475; cli/index.ts:568-597]`.

## Goals / Non-Goals

**Goals:** items 1-17 of the owner request; surface parity preserved; every behavior change has a regression test and doc update.
**Non-Goals:** dashboard UI (SP04), cost/usage sourcing and hook payloads (SP05), renaming the JSON key `alias`, adding `--alias`, run import, CLI i18n.

## Requirements

| # | Requirement | Design |
|---|---|---|
| 1 | `info` cleanup | Delete `printCommandList`, `INFO_GROUP_COMMANDS`, hidden `info doctor`, `info daemon` (+ `stop`/`reload`). Top-level `doctor`/`daemon` unchanged. Info description drops "and the daemon/doctor commands". |
| 2 | Default config file | New `ensureConfigFile(env)` in `src/config.ts`: writes `<dataDir>/config.json` (`configPath()`, 0600, via existing `writeJsonAtomic`) using exclusive create (`flag:'wx'`) so an existing file is never touched. Contents = full explicit `BUILT_IN_CONFIG`: `defaultEngine`, `engines.claude`, `retention`, `logging.fileEnabled`, `defaults{overlap,retry}` (`timeoutSec` omitted: schema forbids null). Called from daemon startup (after `ensureDirs`, `daemon/index.ts:147`) and `CrontickClient.ensure()`. `info` stays read-only (still reports "not created yet" before first use). `initConfig` reuses the same template. |
| 3 | Schedule help | Remove the `addHelpText('after')` Schedule block and the timezone sentence from CLI help. Options list keeps one line each: `--cron <expr>`, `--every <interval>`, `--at <datetime>` prefixed "Schedule (exactly one of --cron/--every/--at):" - the only place they appear. Timezone semantics move to `docs/reference/cli.md`/specs. **Remove `--tz`** everywhere (see D4). |
| 4 | Help text | `--session-id <id>`: "Run it on a given session ID". `--reuse-session`: "Start session and resume on succeeding runs." `--overlap <policy>`: "Overlap policy: skip\|queue\|cancel-previous (default: skip)" on both new and update (the "omit on update to leave unchanged" nuance stays in docs; the code already treats undefined as unchanged, `cli/index.ts:222-228`). |
| 5 | Short flags | `-n, --name <name>`, `-p, --prompt <text>` in `commonJobOptions`. Help: `--name`: "Unique kebab-case job alias (auto-generated when omitted)". Known short flags before `--` are consumed by Commander; after `--` they still pass through to the engine (`splitPromptEngineArgs` unchanged). |
| 6 | Alias consistency | See D1/D2 and touchpoint list below. |
| 7 | Alias collision | See "Alias generation". |
| 8 | Working dir | `-C, --cwd <dir>` on new and update; stored as `action.cwd`. See "Working directory". |
| 9 | Trust check | See "Claude trust". |
| 10 | update == new | Every option above lives only in `commonJobOptions`; `collectJobOptions`/`collectPatchOptions` both gain `cwd`/`trustFolder`; shared `JobCreateCliOptions` gains `cwd`, `trustFolder`; a sync test asserts the option sets of `jobs new` and `jobs update` differ only by `--force` vs `--enable/--disable`. |
| 11 | `jobs schedule` status | `jobSchedule` returns `enabled: boolean`; CLI prints `status: enabled\|disabled` before the fire times; MCP result includes the same field. |
| 12 | Delete removes runs | See "Run deletion". |
| 13 | Runner Session ID | Display label only, in the new `runs get` and `jobs get` formatters (and docs/MCP descriptions). JSON keys `sessionId` unchanged (D6). |
| 14 | `runs get` absorbs logs/output | See "runs get". |
| 15 | `stats job` | See "stats job". |
| 16 | `share export` | `--out <file>`: final path = given name unchanged if it ends in `.json` (case-insensitive), else `.json` appended (`try_me.txt` -> `try_me.txt.json`, `backup` -> `backup.json`); printed as `Exported N job(s) to <abs path>`. `--only-jobs <list>`: comma-separated ids or aliases, resolved server-side, any unknown -> `JOB_NOT_FOUND` listing all misses, nothing written. `--include-runs` removed. |
| 17 | `share import` | See "Share schema". |

### Alias: single term (D1/D2)

Final term: **alias**. The create output already prints `alias:` (JSON key = DB column = `store.getJob(idOrAlias)` = daemon `JOB_ALREADY_EXISTS`), so "alias" has the widest existing footprint and the owner asked for one term. The flag stays `--name`/`-n` because the owner is explicitly adding `-n` to it and Decision 15 of SP01 made `--name` boo-parity; it is documented once as "`--name`: sets the job alias". `--alias` stays rejected (regression-guarded in `splitPromptEngineArgs`). No JSON/field rename.

Touchpoints to change (labels only unless noted):
- CLI arg/option labels `<id|alias>`: `jobs update/get/schedule/delete/run-now`, `stats job`, `runs list --job <id|alias>`, `share export --only-jobs <id|alias,...>`; descriptions "id or name" -> "id or alias" (`cli/index.ts:428,454,459,466,490,562`).
- MCP: every `Job id (GUID) or name` / `(id or name)` string (`mcp/index.ts:149,176-348`) -> "id or alias"; param descriptions e.g. `id: 'Job id (GUID) or alias'`; create tool text drops "(the CLI --name flag)" ambiguity and says "alias (set via CLI `--name`)".
- Schemas: `JobBaseSchema.alias`/`JobPatchInputSchema.alias` describe + regex message "Job alias must be kebab-case"; `job-input.ts` doc comments.
- Errors: `JOB_NOT_FOUND` "Job X not found" -> "Job X not found (id or alias)"; duplicate message already says alias.
- Docs: `docs/reference/{cli,mcp-tools,library-api,glossary}.md`, `docs/specs/001,007`, `docs/concepts/jobs.md#identity`, `README.md`, `src/skill/SKILL.md`, `docs/examples/cli/README.md`. Add a glossary line: "alias - the unique kebab-case job name; `--name`/`-n` sets it."
- Verified gaps: none functional. Resolution already works for get/update/delete/enable/disable/run/schedule/stats/`runs list --job`. Runs have no alias (unchanged). Add one parametrized test hitting each route by alias.

### Alias generation (D3)

Current behavior is already regenerate-on-collision. Changes in `generateAlias`/`api.ts`: (a) after 50 `<word>-<n>` attempts fall back to `<word>-<6-char base36 from crypto.randomUUID>` with up to 5 more attempts, then throw; (b) POST `/api/jobs` wraps `upsertJob` for auto-generated aliases: on UNIQUE-constraint failure regenerate and retry (max 3), explicit aliases still return `JOB_ALREADY_EXISTS`. Regression tests: `generateAlias` with `isTaken` true for every `<word>-<n>` returns the fallback shape; API test with a store whose `getJob` lies once (simulated race) still creates a job; existing `job-input.test.ts:761` cases kept.

### Working directory (D5)

- Stored in existing `action.cwd` (no new field). CLI default = `process.cwd()` of `jobs new`; library/MCP default = client `options.cwd ?? process.cwd()` (MCP tool text tells agents to pass the project folder, since hosts often launch the server in `/`).
- `normalizeJobInput`/`normalizeJobPatch` resolve to an absolute path (`path.resolve(clientCwd, value)`), require existing directory (`INVALID_CWD`), applied identically on create/update/import. The runner's spawn-time check (`runner.ts:158-172`) remains the backstop.
- Shown in `jobs get`, `jobs list`, MCP job JSON, and `jobs schedule`.
- `jobs update --cwd` changes only cwd; changing cwd on a `reuseSession`/`sessionId` job is rejected unless `--session-id` is also changed or reuse is reset (Claude sessions are keyed by cwd: `claude-transcript.ts:36-41`); error `CWD_CHANGE_BREAKS_SESSION` with fix text. Reuse-session state is reset to a fresh start by passing `--reuse-session` again.

### Claude trust (D7)

Mechanism (verified on this machine's `/root/.claude.json`: top-level `projects{<abs path>: {hasTrustDialogAccepted:boolean, allowedTools:[], ...}}`; 11 entries, `/root` true, `/root/projects/cc-gateway` false): Claude treats a folder as trusted when its entry, or an ancestor's entry, has `hasTrustDialogAccepted: true` (parent inheritance, home dir included). The file lives at `$CLAUDE_CONFIG_DIR/.claude.json` when that env var is set, else `~/.claude.json`.

Design:
- New `src/engines/claude-trust.ts` with injectable `{ fs, env, homedir }`: `isFolderTrusted(cwd)`, `trustFolder(cwd)`. Exposed through new optional `EngineAdapter` hooks `checkFolderTrust?`/`trustFolder?` (`ClaudeAdapter` implements, `RawAdapter` does not, so non-Claude runners skip the check).
- `isFolderTrusted`: exact path (and its `realpath`), then each ancestor; missing/unreadable/non-JSON file = not trusted for check purposes.
- `trustFolder`: read raw text, `JSON.parse`; if it fails abort with `CLAUDE_CONFIG_UNREADABLE` and touch nothing; set `projects[abs].hasTrustDialogAccepted = true` preserving the existing entry (new entry: `{allowedTools: [], hasTrustDialogAccepted: true}`); all other keys untouched; serialize with 2-space indent + trailing newline; write `.claude.json.<pid>.tmp` (mode of the original, default 0600) then `rename`. Claude rewrites this file often, so re-`stat` mtime/size just before rename and retry the read-modify-write up to 3 times on change.
- Client `createJob`/`updateJob`/`importJobs` (job whose resolved engine adapter has the hook, and for update only when `cwd` or engine changed): if untrusted and `trustFolder !== true` -> throw `CrontickError('TRUST_REQUIRED', "Folder X is not trusted by Claude...", {cwd, engine})`; if `trustFolder === true` call `trustFolder` first. Nothing is persisted on failure (check precedes the POST).
- CLI shim: catch `TRUST_REQUIRED`; when `stdin`/`stdout` are TTYs print `Folder X is not trusted by Claude. Trust it? (y/N)`; `y` -> retry with `trustFolder:true`; anything else -> exit 1, job not created. No TTY -> error line includes "re-run with --trust-folder". `--trust-folder` flag (new and update, in `commonJobOptions`) answers yes non-interactively. MCP: `trustFolder: z.boolean().optional()` on create/update/import; the error text tells the agent to ask the user and call again with `trustFolder:true`.
- Caveat recorded in docs: `claude -p` itself skips the interactive trust dialog; the persisted flag still governs project-scoped settings/hooks loading, so the check is a guardrail for the owner's intent, not a hard Claude requirement. This is why failure to read `.claude.json` is "not trusted" (prompted) rather than fatal.

### Run deletion (D8)

Root cause above. Fix: `Store.deleteJob` becomes one transaction deleting `run_logs` (by run ids), `runs`, `job_schedule_state`, then the `jobs` row; per-job log file (`<logging.dir ?? logsDir>/<jobId>.log`, name via `safeLogFileName`) unlinked best-effort after commit; job JSON files as today. API order: `scheduler.unschedule`, `runner.cancelJob`, then delete; response gains `deletedRuns`. New `Store.purgeOrphans()` at daemon start (`daemon/index.ts`, before reconcile): delete runs whose `job_id` has no job, logs whose run is gone, schedule state whose job is gone; log count at info. `listRunsForExistingJobs` and the INNER-JOIN branch of `queryRuns` are removed (all reads use `listRuns`). Claude's own transcripts are never deleted. Tests: delete one job, then `listRuns`/`runs list`/`getRun`/`getLogs`/stats/dashboard payload show no trace (all three surfaces); seed an orphan run, restart store, assert purged; in-flight run delete leaves no orphan logs; update `stats-excludes-deleted-job-runs.test.ts` to the new contract.

### `runs get`, `runs logs`/`runs output` (D9)

- **Removed:** CLI `runs logs`, `runs output`; `CrontickClient.getLogs`, `LogsResult`, `LogEntry`, `LogSource`/`LOG_SOURCES` exports and `log-source.ts` client use; MCP `crontick_run_logs_tail` and `crontick_run_output`; `SURFACE_CAPABILITIES` entries `logs` and `run-output`; their parity/test cases.
- **Kept:** `getOutput` (library-only, like `previewSchedule`, not in the surface table) and `GET /api/runs/:id/output` (SP04 dashboard and `runs get` consume it); `/api/runs/:id/logs` and `/logs/stream` kept until SP04 confirms the dashboard switched to the path link, then SP04 may drop them.
- **`getRun`** keeps its record shape and adds `logFile` (absolute path, computed by the daemon from `logging.dir`/`logsDir` + job id; null when file logging is off). Interface with SP04: this `logFile` field is the shared source for the dashboard's raw-log link.
- **`crontick runs get <runId>`** (formatter `formatRunDetail` in `run-format.ts`, pure): one `Label: value` line per record field with local-ISO timestamps (`formatLocalIso`), `Runner Session ID`, the `Transcript:` line, then directly below `Log file: /abs/path/<jobId>.log`, blank line, then cleaned output from `getOutput`: `error` (if any), the `result` else readable `output`, `[stderr]` only when no error. The Status line is printed once (in the field block), never repeated. Note for owner: crontick keeps ONE per-job log file carrying both engine and crontick events for all runs of that job (`job-log-file.ts`), so a single path is printed; the engine/crontick split exists only in SQLite and is not exposed. `--json` prints `{ run, output }`.
- **MCP `crontick_run_get`** returns the record plus `logFile` and `output` (the cleaned view), so agents lose no capability; raw log tail is intentionally dropped (agents can read `logFile`).

### `stats job` (D10)

`lastRunAt` printed with `formatLocalIso` in the CLI; JSON/MCP value stays epoch ms and the CLI-only formatter converts (shim presentation, no logic). Counts are computed over all retained runs of the job (drop the `limit:100`), and `stats job` prints `totalTurns (agent turns, summed over runs)`. Docs state the definition below.

### Share schema (D11)

Zod in `src/job-input.ts` (existing style), exported internally:
`ExportFileSchema = z.object({ schema: z.literal(1), exportedAt: z.string().optional(), crontickVersion: z.string().optional(), jobs: z.array(ImportJobSchema) })` where `ImportJobSchema` = `JobCreateInputSchema` with `id` accepted but ignored. Export emits `{schema:1, exportedAt, crontickVersion, jobs}` with job `id` omitted and no `runs`. Import (CLI parses file, client `importJobs(file)` validates, daemon route trusts only validated jobs): wrong/missing `schema`, bare arrays, or invalid shape -> `VALIDATION_ERROR` naming the path (`jobs.2.schedule: ...`) and nothing imported (validate all, then apply); missing optional fields (description, retry, overlap, args, ...) are filled by the same normalization as create. Every imported job gets a **new GUID**; on alias collision with a live job (or earlier in the same file) the alias becomes `<alias>-2`, `-3`, ... and the result row reports `{alias, renamedFrom}` (never overwrites). Existing `sessionId` handling via `prepareImportedJob` keeps resetting foreign sessions. `cwd` is validated per job (missing folder -> that row fails `INVALID_CWD`, others proceed) and trust is checked once per distinct folder with the same `TRUST_REQUIRED`/`--trust-folder` flow. Removed: `--include-runs`, MCP `includeRuns`/`runs`, `?includeRuns=1`, `Store.importRuns`, `RunImportSchema`, the "(and run history, if present)" help text. New import help: "Import jobs from a crontick export file (schema 1). Jobs get new ids."

## Answers

**What is `totalTurns: 6` in `crontick stats job`?** It is the sum of `runs.turns` for the job's runs. Per run, `turns` is Claude's `result.num_turns` from the stream-json final event (`claude-adapter.ts:113-126`), i.e. the number of agentic model round-trips (each assistant response, including tool-use rounds) that the run took, accumulated across retry attempts (`runner.ts:438`). So 6 could be 3 runs of 2 turns each. It is not a count of runs, messages, or tokens. Today it only covers the latest 100 runs (fixed above). Name kept (`totalTurns`) with a clarified label and docs; no rename since "turns" is Claude's own term.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | User-facing term is **alias**; flag stays `--name`/`-n`; `--alias` stays rejected | Widest existing footprint; owner wants `-n` on `--name` |
| D2 | JSON/DB key `alias` unchanged; MCP/CLI/errors/docs text says "alias" | No data migration; one term |
| D3 | Alias retry plus word-suffix fallback plus race retry | Request 7 |
| D4 | Remove `tz` from `CronScheduleSchema`, scheduler/preview (`tz` param, `api.ts:337`), `dashboard.ts:330`. Cron fires in machine local time. Legacy stored `tz` is ignored and the daemon logs one warning per affected job at startup | Owner request; stored JSON is not zod-parsed on read (`JSON.parse(row.json)`) so warn rather than silently reinterpret. Pre-1.0 breaking, changeset (minor) |
| D5 | cwd = `action.cwd`; flag `--cwd`/`-C`; default CLI cwd | Field already exists and is honored by runner |
| D6 | Keep `sessionId` JSON keys; rename only displayed labels to "Runner Session ID" | Avoids breaking stored jobs/API; SP04 mirrors on dashboard |
| D7 | Trust logic in `claude-trust.ts` behind adapter hook; prompt in CLI only; `TRUST_REQUIRED` + `trustFolder` | Shim has zero logic; fs injectable (AGENTS rules 6/7) |
| D8 | Delete job = delete its runs/logs/state; purge orphans at startup | Single source of truth across surfaces |
| D9 | Remove `getLogs`, MCP logs/output tools and surface entries; keep `getOutput` + HTTP `/output` | Owner request; dashboard dependency |
| D10 | Short flag `-n` on `jobs schedule --count` kept (different subcommand) | No conflict within a command; noted in docs |
| D11 | Share format `schema:1`, jobs only, ids regenerated, alias collisions suffixed | Request 17 |
| D12 | Default config written in full, `wx` create, never overwritten | Discoverable and safe; trade-off: built-in default changes in later versions will not reach users with a file (documented) |

## Architecture / Interfaces

- Surface table after change: remove `logs`, `run-output`; modified: `create-job`/`update-job` (`trustFolder`), `export` (`onlyJobs`), `import` (schema), `get-run` (`logFile`+`output`), `job-schedule` (`enabled`), `stats-job`.
- SP04 contract: `GET /api/runs/:id/output` unchanged (shape of `RunOutput`); run record gains `logFile`; job record gains nothing new (`action.cwd` already present); `tz` disappears from dashboard schedule text; labels "Runner Session ID". SP05 contract: none beyond `turns`/`costUsd` fields unchanged.
- Files touched: `cli/index.ts`, `client.ts`, `job-input.ts`, `schemas/job.ts`, `config.ts`, `daemon/{api,store,index,scheduler}.ts`, `mcp/index.ts`, `surface.ts`, `index.ts` (drop removed exports), `run-format.ts`, `engines/{types,claude-adapter,claude-trust}.ts`, docs, changeset.

## Manual steps

None required. Owner may later review `~/.claude.json` edits by the trust flow; no credentials or account access involved.

## Risks / Open Questions

| Item | Status |
|---|---|
| `-p` short flag vs engine `-p` after `--` | [RESOLVED: only pre-`--` tokens are crontick options; post-`--` tokens pass through] |
| Claude rewriting `.claude.json` concurrently | [RESOLVED: stat-guarded retry, abort on parse failure] |
| Does Claude trust persist for paths via symlink | [RESOLVED: check exact and realpath, write the exact resolved path] |
| Exact semantics of `num_turns` for sub-agent turns | [DEFERRED: SP05 may refine the doc wording] |
| Separate engine vs crontick log files per run | [DEFERRED: single per-job file kept; revisit if owner needs a split] |
| Dashboard still using `/logs` routes | [DEFERRED: SP04 decides when to drop them] |
| Legacy exports without `schema` | [RESOLVED: rejected with clear error; pre-1.0] |

## Acceptance Criteria

- `crontick info` shows no commands list; `crontick info daemon`/`info doctor` are unknown commands; `crontick doctor`/`daemon` work.
- Fresh `CRONTICK_HOME`: first `jobs new` creates `config.json` with the full defaults; a hand-edited file is byte-identical after further runs.
- `jobs new --help` lists each schedule flag once, no timezone sentence, no `--tz`; `-n`, `-p`, `-C`, `--trust-folder`, and the new help strings appear on both new and update; option-sync test passes.
- Alias: all listed commands/tools accept alias and say `<id|alias>`; auto-alias collision and fallback tests pass.
- `jobs new` without `--cwd` stores the invoking directory; nonexistent dir rejected; untrusted Claude folder: TTY `y` trusts and creates, `n` creates nothing; non-TTY errors `TRUST_REQUIRED`; `--trust-folder`/`trustFolder` succeeds; other `.claude.json` keys byte-preserved (test with fake fs).
- Deleting a job leaves zero runs/logs on every surface; orphan purge test; `jobs schedule` prints enabled/disabled.
- `runs logs`/`runs output`/`crontick_run_logs_tail`/`crontick_run_output` absent; `runs get` prints log path under transcript, output, a single Status; `stats job` prints a local-ISO `lastRunAt`.
- `share export --out try_me.txt` writes `try_me.txt.json`; `--only-jobs` filters; import rejects missing/wrong `schema`, assigns new ids, suffixes alias collisions, ignores/never imports runs.
- `npm run validate` passes; changeset (minor) and docs/reference + specs updated, surface-drift test green.
