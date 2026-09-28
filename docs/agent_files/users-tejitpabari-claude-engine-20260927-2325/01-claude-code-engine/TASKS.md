---
status: draft
summary: Engine-adapter framework + Claude Code adapter, decomposed into 13 dependency-ordered tasks
date: 2026-09-28
---
# Tasks: Engine framework + Claude Code adapter

Source of truth: `docs/agent_files/users-tejitpabari-claude-engine-20260927-2325/01-claude-code-engine/PRD.md`. Fresh authoring — no prior TASKS.md existed for this sub-project. Tasks trace to PRD requirements R1-R13 and the numbered Decisions; each is sized as one coherent, independently buildable/testable commit.

| # | Task | Depends on | Status |
|---|---|---|---|
| 1 | Adapter contract, registry, and `EngineConfigSchema.type` | none | todo |
| 2 | Extract `RawAdapter`; core dispatches via registry | 1 | todo |
| 3 | `ClaudeAdapter.buildInvocation` + session-id pre-assignment + fake-claude helper | 1, 2 | todo |
| 4 | `ClaudeAdapter.parseResult`: stream-json, cost/turns/usage, success/failure rule | 3 | todo |
| 5 | Resume-target safety: transcript preflight, `SESSION_NOT_FOUND`, stdin ignore | 4 | todo |
| 6 | Run-record + storage delta for engine fields, surfaced across CLI/MCP/library | 4 | todo |
| 7 | Default engine becomes `claude`; `copilot` removed entirely | 3 | todo |
| 8 | `skipped` run status + `reuseSession`-requires-`overlap:skip` refinement | 6 | todo |
| 9 | Reserved-arg extension + argument passthrough | 3 | todo |
| 10 | `config.json` `defaults` section (overlap/timeoutSec/retry), snapshotted | 1 | todo |
| 11 | CLI flag renames: `--alias`→`--name`, `--engine`→`--runner` | 9, 10 | todo |
| 12 | Completion-marker `SessionEnd` hook + restart-reconciliation fallback | 3, 5 | todo |
| 13 | Documentation, spec, ADR, and changeset wrap-up | 1-12 | todo |

## Task 1 — Adapter contract, registry, and `EngineConfigSchema.type`
What it is / what it means: Establishes the template-method seam design-principles.md #1 requires: an `EngineAdapter` abstract contract and a registry mapping `EngineConfig.type` to an adapter instance, so the core never branches on engine name (Decision 1/2).
What changes at a high level: New `src/engines/types.ts` (`EngineOptions`/`EngineInvocation`/`EngineResult`/`EngineAdapter` per the PRD's Architecture section) and `src/engines/registry.ts` (`raw`→`RawAdapter`, `claude`→`ClaudeAdapter` lookup — adapters can be stub classes for now, filled in by later tasks). `EngineConfigSchema` (`src/schemas/config.ts`) gains `type: z.enum(['claude','raw']).default('raw')` (R1) — unset `type` must resolve to `raw` with zero behavior change for existing custom engines.
Done when: registry resolves both type strings to a constructible adapter; schema default is verified by a test asserting an engine config with no `type` parses to `raw`; `npm run build && npm test` passes.

## Task 2 — Extract `RawAdapter`; core dispatches via registry
What it is / what it means: Moves today's engine-agnostic behavior (argv assembly, `extractSessionId()` regex scrape, exit-code-only result table) into `RawAdapter` unchanged, and rewires `src/config.ts#buildPromptRunCommand` and `runner.ts`'s `close` handler to resolve an adapter from the registry and delegate `buildInvocation`/`parseResult`/`resolveSessionId` to it instead of inline logic.
What changes at a high level: `src/engines/raw-adapter.ts` (new); `src/config.ts` and `src/daemon/runner.ts` lose their inline engine logic in favor of registry delegation; `src/daemon/prompt-session.ts` either becomes this adapter's session-capture helper or is subsumed into it, per the PRD's stated either/or.
Done when: `tests/prompt-session.test.ts` and `tests/config.test.ts` pass unchanged against the refactor (behavior-preserving refactor, not a rewrite); no `if (engine === ...)` branch remains in `config.ts`/`runner.ts`.

## Task 3 — `ClaudeAdapter.buildInvocation` + session-id pre-assignment + fake-claude helper
What it is / what it means: Implements the Claude-specific argv shape and the crontick-assigns-first-not-scraped session id model (R3, R4's `sessionId` piece, Decision 4): a fresh run gets `randomUUID()` and `--session-id <uuid>` before spawn; a resume attempt uses `--resume <sessionId>` — never `--session-id` to resume.
What changes at a high level: `src/engines/claude-adapter.ts` (new) with `buildInvocation` producing `claude -p <prompt> --output-format stream-json --verbose <session-flag> ...actionArgs --settings <json>`; registry registers it for `type: 'claude'`. New `tests/helpers/fake-claude.ts` emitting configurable `stream-json` NDJSON (init/assistant/result lines) with settable exit code, `is_error`, and delay, so later tasks can drive it without a real `claude` binary.
Done when: unit tests assert correct argv for both the new-session and resume cases using the fake binary; `run.sessionId` is persisted immediately post-spawn, before any output is read.

## Task 4 — `ClaudeAdapter.parseResult`: stream-json, cost/turns/usage, success/failure rule
What it is / what it means: Implements the Claude-specific result-parsing half of the adapter (R5, Decision 3/5): scan the captured stdout tail backwards for the last well-formed `"type":"result"` line, extract `session_id`/`total_cost_usd`/`usage`/`is_error`/`num_turns`/`subtype`/`result`, and apply `exitCode===0 && !is_error` → `success`, `exitCode===0 && is_error` → `failed` (a new adapter-scoped failure mode `RawAdapter` doesn't have). Falls back to the exit-code table when the cap truncated mid-line or no result line ever appeared.
What changes at a high level: `parseResult`/`resolveSessionId` in `src/engines/claude-adapter.ts`, reusing the existing `captureChunk`/redaction/128 KB-tail pipeline unchanged (no new capture code).
Done when: using `tests/helpers/fake-claude.ts`, a run with `is_error: true` and exit code 0 records `failed` with `error` from `result`/`subtype`; a truncated/missing result line falls back to exit-code-only status; cost/turns/usage populate on success.

## Task 5 — Resume-target safety: transcript preflight, `SESSION_NOT_FOUND`, stdin ignore
What it is / what it means: Implements Decision 17/R8's safety design so `--resume` is never sent for an id Claude can't resume, which today opens a blocking interactive picker with no TTY to answer it in a detached daemon child. A `sessionId` is only offered to `--resume` if captured from a prior run whose `parseResult` actually completed (`success`/`failed`), and only after confirming its transcript file exists.
What changes at a high level: shared `resolveTranscriptPath(cwd, sessionId)` helper (cwd-encoding rule: replace every `/` and `.` with `-`) used both here and for the `transcriptPath` field (Task 6); a preflight check in the run path that fails fast with a new error code `SESSION_NOT_FOUND` (superseding `CLAUDE_RESUME_FAILED`) before any process is spawned; `runner.ts` spawn sets `stdin: 'ignore'` for every prompt job, not just Claude's, as defense in depth.
Done when: a job with a `sessionId` whose transcript file is missing fails fast with `SESSION_NOT_FOUND`, verified against a spy/mock on `spawn` proving no process is ever started (not just an exit-code assertion, since the bug is a pre-spawn hang).

## Task 6 — Run-record + storage delta for engine fields, surfaced across CLI/MCP/library
What it is / what it means: Delivers R4's storage fields and R6's surface-parity requirement together, since they're one observable change: every run can carry `costUsd`, `turns`, `usageJson` (redacted raw `usage` block), `transcriptPath`, and `engineStatus` (Claude's `subtype`), absent for `RawAdapter` runs, and existing capabilities (`runs get`, `stats summary`, `stats job`) expose them without a new `SURFACE_CAPABILITIES` row.
What changes at a high level: `runs` table gains `cost_usd REAL`, `turns INTEGER`, `usage_json TEXT`, `transcript_path TEXT`, `engine_status TEXT` (plain schema addition, no migration, per ADR 0017); `finalizeRun()` writes them from the adapter's `EngineResult`; `src/client.ts`, `src/cli/index.ts` (`runs get`), `src/mcp/index.ts` (`crontick_run_get`) all surface the new fields; `docs/reference/` updated for the affected commands.
Done when: `tests/surface-drift.test.ts` still passes with no new capability row; a Claude run's `costUsd`/`turns`/`usageJson`/`transcriptPath`/`engineStatus` are readable via CLI, MCP, and library after a fake-claude run; a `RawAdapter` run leaves them absent/null.

## Task 7 — Default engine becomes `claude`; `copilot` removed entirely
What it is / what it means: Delivers R2/Decision 8 (owner-approved, no manual sign-off needed): `claude` becomes the sole built-in engine, and `copilot` is removed entirely from `BUILT_IN_CONFIG.engines` and from `EngineConfigSchema`'s built-in default — not merely demoted from default.
What changes at a high level: `src/config.ts`'s `BUILT_IN_CONFIG.defaultEngine` → `'claude'`; a built-in `claude` entry (`{ command: 'claude', args: [], env: {}, type: 'claude' }`) added; all `copilot` references removed from `BUILT_IN_CONFIG`/`EngineConfigSchema`'s built-in default. `tests/helpers/fake-engine.ts`'s comment and any test asserting `copilot` as the default are updated to reflect `claude`.
Done when: `BUILT_IN_CONFIG.defaultEngine === 'claude'`; a `config.json` naming `copilot` as `defaultEngine`/an `engines` key hits the existing "must match a key in engines" validation like any unknown engine, with a test proving it; no `copilot` string remains in `BUILT_IN_CONFIG`/`EngineConfigSchema`.

## Task 8 — `skipped` run status + `reuseSession`-requires-`overlap:skip` refinement
What it is / what it means: Delivers R10, R13, and Decision 11/16 together, since the acceptance criteria exercises them as one flow: a reused session's in-flight run is never canceled, so `reuseSession: true` is schema-restricted to `overlap: 'skip'`, and every overlap-skip (not only reused-session ones) now records a distinct terminal status `skipped` instead of today's `canceled`.
What changes at a high level: `JobSchema` cross-field refinement rejecting `reuseSession===true` with `overlap !== 'skip'` as a `VALIDATION_ERROR`; `RunStatus`/`RUN_STATUS_VALUES` (`src/daemon/store.ts`) gains `'skipped'`, mirrored by hand in `src/cli/index.ts`'s `RUN_STATUSES` and `src/mcp/index.ts`'s run-status `z.enum`; `Runner.run()`'s `overlap==='skip' && isActive` path writes `status: 'skipped'` instead of `'canceled'`; `docs/reference/` run-status tables document the distinction.
Done when: `jobs new --reuse-session --overlap queue` is rejected; `--reuse-session` alone succeeds; a second fire while active records `skipped`; `runs list --status skipped` and the `canceled`/`skipped` breakdown in `stats summary`/`stats job` both work.

## Task 9 — Reserved-arg extension + argument passthrough
What it is / what it means: Delivers R7 (extend the one static, engine-agnostic reserved-arg list with `--output-format`/`--settings`, Decision 7) together with R9 (open-ended passthrough, Decision 9/12/13), since passthrough's whole purpose is forwarding flags crontick doesn't recognize while still rejecting ones that collide with the extended reserved list.
What changes at a high level: `src/prompt-runtime.ts`'s `RESERVED_PROMPT_ARGS` gains the two entries; `jobs new`/`jobs update` (`src/cli/index.ts`) set Commander's `allowUnknownOption()`, collecting unrecognized long-form flags (with their value if the next token isn't flag-shaped) in argv order; `resolveActionArgs()` (`src/job-input.ts`) merges this third source with the existing `--`/`--arg` sources (still mutually exclusive with each other, per ADR 0018/0019) before the reserved-arg check runs against the merged list.
Done when: `jobs new --prompt "..." --allow-all` stores and forwards `--allow-all` verbatim in `action.args`; a passthrough flag matching `RESERVED_PROMPT_ARGS` is rejected at create/update time with the same error as today's reserved-arg check.

## Task 10 — `config.json` `defaults` section, snapshotted
What it is / what it means: Delivers R11/Decision 14: a `defaults` section (`overlap`, `timeoutSec`, `retry`) on `ConfigSchema`/`PersistedConfigSchema`, mirroring the existing Persisted/effective split used for `retention`/`logging`, replacing the hardcoded constants `job-input.ts` currently uses.
What changes at a high level: schema additions in `src/schemas/config.ts`; `BUILT_IN_CONFIG.defaults` in `src/config.ts` supplies `overlap: 'skip'`, `retry: { max: 0, backoffSec: 30 }`, `timeoutSec: undefined`; `job-input.ts` resolves precedence CLI flag > per-job JSON > `config.json` `defaults.*` > `BUILT_IN_CONFIG.defaults` once at create/update time and snapshots the result into the job file (matching the existing `defaultEngine` precedent), so a later `config.json` edit never retroactively changes an existing job.
Done when: a new job omitting the matching CLI flag honors `config.json`'s `defaults.overlap`/`defaults.timeoutSec`/`defaults.retry`; a job created before a `config.json` defaults edit is unaffected by that later edit.

## Task 11 — CLI flag renames: `--alias`→`--name`, `--engine`→`--runner`
What it is / what it means: Delivers R12/Decision 15 (boo-parity): a hard rename on `jobs new`/`jobs update`, no deprecated alias kept alongside (design-principles.md #6, pre-1.0 per ADR 0027). Underlying schema fields (`alias`, `action.engine`) are unchanged — this is CLI-surface only.
What changes at a high level: `src/cli/index.ts` option definitions and help text for `jobs new`/`jobs update`; any CLI-layer tests/examples referencing `--alias`/`--engine` updated to `--name`/`--runner`.
Done when: `crontick jobs new --name <n> --prompt <p> --runner claude --every 30m` works; `--alias`/`--engine` no longer appear in `--help` output; a test asserts the old flag names are rejected as unknown options.

## Task 12 — Completion-marker `SessionEnd` hook + restart-reconciliation fallback
What it is / what it means: Implements Decision 9's best-effort supplement for the one gap normal-run parsing can't cover: a run that finishes while the daemon is down. `buildInvocation` always appends an ephemeral `--settings` JSON (never touching the user's own `~/.claude/settings.json`) registering a `SessionEnd` hook that writes `{exitStatus, sessionId}` to `<dataDir>/runs/<runId>.claude-hook.json`. This is explicitly non-authoritative — every normal-run outcome still comes from Task 4's `parseResult`, never from the hook.
What changes at a high level: `ClaudeAdapter.buildInvocation` (Task 3) gains the `--settings` hook registration; `reconcileOrphanRuns()` (daemon startup path) checks for the marker file before falling back to `ADOPTED_RUN_EXITED_MESSAGE`.
Done when: a completion-marker file, when present, overrides `ADOPTED_RUN_EXITED_MESSAGE` on daemon restart reconciliation in a test; absence of the marker leaves today's fallback behavior unchanged. Owner live-validates actual hook firing/payload shape after this lands (see closing note).

## Task 13 — Documentation, spec, ADR, and changeset wrap-up
What it is / what it means: Closes out AGENTS.md's documentation rules and the PRD's own acceptance criteria for the parts not already covered inline by earlier tasks' `docs/reference/` touches: the narrative spec update and a lasting-decision ADR for the adapter framework itself.
What changes at a high level: `docs/specs/007-prompt-jobs.md` updated for the adapter framework, Claude adapter behavior, new run fields, `skipped` status, passthrough, config defaults, and the CLI renames; a new ADR under `docs/decisions/` (next number after 0028) recording the `EngineAdapter`/registry framework as a lasting design decision; `npx changeset` entry covering the whole sub-project's public-API surface (schema fields, CLI flags, MCP fields, new run fields).
Done when: `docs/specs/007-prompt-jobs.md` and `docs/reference/` read consistently with the shipped behavior; the ADR exists and is cross-referenced from `docs/decisions/README.md` if one exists; a changeset file is present; `npm run validate` passes end-to-end.

---

**Closing note (manual/owner-only step, not assignable to a coding agent):** per the PRD's Manual steps and Risks/Open Questions, the owner live-validates the `SessionEnd`/`Stop` hook's actual firing semantics and payload shape in `-p` mode *after* Task 12 lands — this is deferred and non-blocking, since every normal-run correctness path (Task 4) is already hook-independent. No other manual step blocks this sub-project; the `defaultEngine`/`copilot`-removal breaking change (Task 7) is already owner-approved per the PRD (R2/Decision 8, ADR 0027).
