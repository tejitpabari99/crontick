---
status: done
summary: SP03 CLI and job model - 9 commit-sized tasks covering alias term, CLI cleanup, tz removal, run deletion, cwd, Claude trust, runs get/stats, share schema 1, and final tests/docs/changeset.
date: 2026-10-01
---
# Tasks: SP03 - CLI & Job Model
Source of truth: docs/agent_files/users-tejitpabari-claude-engine-20260927-2325/03-cli-and-job-model/PRD.md. Tasks follow dependency order. Any change touching a capability updates client, CLI, MCP and `SURFACE_CAPABILITIES` together (surface parity). Siblings SP04 (dashboard + daemon port) and SP05 (engine observability) are out of scope; only the `logFile` / `/output` contracts are honored for SP04.

| # | Task | Depends on | Status |
|---|---|---|---|
| 1 | Alias as the single term + alias generation hardening | - | done |
| 2 | `info` cleanup + default config file | - | done |
| 3 | Job option cleanup: help text, short flags, `--tz` removal, option-sync | 1 | done |
| 4 | Delete job removes runs/logs + orphan purge | - | done |
| 5 | Per-job working directory (`--cwd`/`-C`) | 3 | done |
| 6 | Claude folder trust check and `--trust-folder` | 5 | done |
| 7 | `runs get` absorbs logs/output, `stats job`, `jobs schedule` status | 4 | done |
| 8 | Share export/import schema 1 | 5, 6 | done |
| 9 | Tests, docs, reference/specs, changeset for SP03 | 1-8 | done |

## Task 1 — Alias as the single term + alias generation hardening
What it is / what it means: Decisions D1, D2, D3. User-facing wording becomes "alias" everywhere; the `--name` flag, JSON key `alias` and DB column stay. `--alias` stays rejected.
What changes at a high level: Relabel CLI args/options and descriptions (`<id|alias>`, "id or alias"), every MCP tool/param description, schema describe/regex messages, `job-input.ts` comments, and `JOB_NOT_FOUND` text ("not found (id or alias)"). Harden `generateAlias`: after the 50 numeric-suffix attempts fall back to a short random base36 suffix with a few more attempts before throwing. Make `POST /api/jobs` retry (max 3) with a fresh auto-generated alias when a UNIQUE-index race occurs; explicit aliases still return `JOB_ALREADY_EXISTS`.
Done when: all id-accepting commands/tools say id-or-alias, a parametrized test hits each route by alias, fallback-shape and simulated-race tests pass, existing alias tests still pass.

## Task 2 — `info` cleanup + default config file
What it is / what it means: Requirements 1 and 2, D12.
What changes at a high level: Remove the commands list, `INFO_GROUP_COMMANDS`, hidden `info daemon` / `info doctor` (and stop/reload) and the description clause; top-level `doctor`/`daemon` stay. Add `ensureConfigFile` in the config module that exclusively creates `config.json` (0600, atomic write) with the full explicit built-in config and never touches an existing file; `initConfig` reuses the same template. Call it from daemon startup after `ensureDirs` and from the client's ensure path. `info` remains read-only and still reports "not created yet" before first use.
Done when: fresh `CRONTICK_HOME` gets a complete `config.json` on first use, a hand-edited file stays byte-identical, `info daemon`/`info doctor` are unknown commands.

## Task 3 — Job option cleanup: help text, short flags, `--tz` removal, option-sync
What it is / what it means: Requirements 3, 4, 5, 10 and D4.
What changes at a high level: In `commonJobOptions` (shared by `jobs new` and `jobs update`) drop the duplicate Schedule help block and timezone sentence, prefix each schedule flag once with "Schedule (exactly one of ...)", apply the new `--session-id`, `--reuse-session`, `--overlap` and `--name` help strings, and add `-n, --name` and `-p, --prompt` (post-`--` tokens still pass through to the engine). Remove `tz` from the cron schedule schema, scheduler/preview, dashboard schedule text, CLI/MCP/client surfaces; legacy stored `tz` is ignored with one startup warning per affected job. Add a sync test asserting `jobs new` and `jobs update` option sets differ only by `--force` vs `--enable/--disable`.
Done when: help shows each schedule flag once with no `--tz`, short flags work, cron fires in local time, legacy `tz` warns, sync test green.

## Task 4 — Delete job removes runs/logs + orphan purge
What it is / what it means: Requirement 12, D8; the root cause is that single-job delete only removes the `jobs` row.
What changes at a high level: Make the store's job delete one transaction removing run logs, runs, schedule state and the job; unlink the per-job log file best-effort after commit; the API unschedules and cancels in-flight runs first and returns `deletedRuns`. Add a store orphan purge run at daemon start (before reconcile) that removes runs, logs and schedule state whose job is gone, logging counts. Remove `listRunsForExistingJobs` and the INNER-JOIN read branch so all reads share `listRuns`.
Done when: after deleting a job nothing remains in runs list, get run, logs, stats or dashboard payload on any surface; seeded orphans are purged on restart; the stats-excludes-deleted-job test is updated to the new contract.

## Task 5 — Per-job working directory (`--cwd`/`-C`)
What it is / what it means: Requirement 8, D5.
What changes at a high level: Add `-C, --cwd <dir>` to the shared job options (new and update) and `cwd` to the shared CLI option types, collect functions, MCP create/update params and client create/update. Stored in existing `action.cwd`; default is the invoking directory for the CLI and the client option or process cwd for library/MCP (MCP text tells agents to pass the project folder). Normalization resolves to an absolute path and requires an existing directory (`INVALID_CWD`) on create/update. Show cwd in `jobs get`, `jobs list`, MCP job JSON and `jobs schedule`. Reject cwd changes on reuse-session/session-id jobs with `CWD_CHANGE_BREAKS_SESSION` and fix text unless the session is also reset.
Done when: `jobs new` without `--cwd` stores the invoking dir, nonexistent dirs are rejected, session-conflict error works, runs start in the stored cwd.

## Task 6 — Claude folder trust check and `--trust-folder`
What it is / what it means: Requirement 9, D7.
What changes at a high level: New injectable Claude-trust module (fs/env/homedir) with `isFolderTrusted` (exact path, realpath and ancestors, honoring `CLAUDE_CONFIG_DIR`; unreadable means untrusted) and `trustFolder` (safe read-modify-write of `.claude.json` preserving all other keys, abort on parse failure with `CLAUDE_CONFIG_UNREADABLE`, stat-guarded atomic rename with retries). Expose via optional engine adapter hooks implemented only by the Claude adapter. Client create/update (when cwd or engine changed) throws `TRUST_REQUIRED` before persisting unless `trustFolder: true`. CLI prompts y/N on a TTY and retries, errors with a "re-run with --trust-folder" hint otherwise; add `--trust-folder` to shared options; MCP gains `trustFolder` with error text instructing the agent to ask the user. Update `SURFACE_CAPABILITIES` for create/update.
Done when: TTY `y` trusts and creates, `n` creates nothing, non-TTY errors, flag succeeds, other `.claude.json` keys byte-preserved (fake-fs tests), raw engine jobs skip the check.

## Task 7 — `runs get` absorbs logs/output, `stats job`, `jobs schedule` status
What it is / what it means: Requirements 11, 13, 14, 15; D6, D9, D10.
What changes at a high level: Remove CLI `runs logs`/`runs output`, client `getLogs` and its exported types/log-source use, MCP `crontick_run_logs_tail` and `crontick_run_output`, and the `logs`/`run-output` surface entries; keep `getOutput` and the HTTP `/output` route. `getRun` gains `logFile` (null when file logging is off). Add pure `formatRunDetail`: labeled local-ISO fields, "Runner Session ID", transcript line, log file path, then cleaned output with a single Status line; `--json` prints run plus output. MCP `crontick_run_get` returns record, `logFile` and cleaned output. `stats job` prints local-ISO `lastRunAt`, counts all retained runs (drop the 100 cap) and labels `totalTurns` clearly. `jobSchedule` returns `enabled` and the CLI prints `status: enabled|disabled`; update `info`-adjacent surface entries (`get-run`, `job-schedule`, `stats-job`).
Done when: removed commands/tools are absent, `runs get` output matches the PRD, `stats job` totals exceed 100 when applicable, surface-drift test green.

## Task 8 — Share export/import schema 1
What it is / what it means: Requirements 16, 17, D11.
What changes at a high level: Export `--out` appends `.json` unless already present (case-insensitive) and prints `Exported N job(s) to <abs path>`; `--only-jobs <list>` resolves ids/aliases server-side with all misses reported via `JOB_NOT_FOUND` and nothing written; remove `--include-runs`. Export emits `{schema:1, exportedAt, crontickVersion, jobs}` with ids omitted and no runs. Add the export-file zod schema; client import validates the whole file first (wrong/missing schema, bare arrays, bad shapes give `VALIDATION_ERROR` with path), fills optional fields via normal normalization, assigns new GUIDs, suffixes alias collisions (`-2`, `-3`, including within the file) and reports `renamedFrom`. Per-job cwd validation (failing row only) and per-folder trust check with `--trust-folder`/`trustFolder`. Remove run import (`includeRuns`, `Store.importRuns`, `RunImportSchema`, query flag, MCP fields) and update help text; update `export`/`import` surface entries on all surfaces.
Done when: `--out try_me.txt` writes `try_me.txt.json`, filtering works, invalid files import nothing, runs are never imported.

## Task 9 — Tests, docs, reference/specs, changeset for SP03
What it is / what it means: Close-out per AGENTS.md testing and documentation rules.
What changes at a high level: Fill any missing regression tests across Tasks 1-8 (alias routes, delete/purge on all surfaces, option sync, trust fake-fs, share validation) and make `npm run validate` pass. Update `docs/reference/{cli,mcp-tools,library-api,glossary}.md`, relevant `docs/specs/` (including 001 and 007), `docs/concepts/jobs.md`, README, `src/skill/SKILL.md` and `docs/examples/cli/README.md`: alias glossary line, timezone semantics (local time, `--tz` removed), cwd and trust caveat (claude -p skips the dialog; check is a guardrail), `totalTurns` definition, single per-job log file, config-file default trade-off, share schema 1. Add an ADR if warranted and a minor changeset marking the pre-1.0 breaking changes (tz removal, removed log/output commands, export format).
Done when: validate passes, docs match behavior, changeset present.

Closing note: no owner-only manual steps are required for this sub-project.
