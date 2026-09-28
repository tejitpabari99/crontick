---
status: draft
summary: Pluggable engine-adapter framework replacing regex-scrape prompt execution, with a session-aware, usage-aware Claude Code adapter as the first implementation.
date: 2026-09-28
---

# PRD: Engine framework + Claude Code adapter

Repo/branch: crontick, `.worktrees/claude-engine` / `users/tejitpabari/claude-engine`
Depends on: none (Phase 1, first sub-project)
Owns (files): `src/engines/**` (new), `src/constants/engines.ts` (new), `src/schemas/config.ts` (EngineConfigSchema delta), `src/config.ts` (BUILT_IN_CONFIG, `buildPromptRunCommand` → adapter dispatch), `src/daemon/runner.ts` (spawn/result handling), `src/daemon/prompt-session.ts` (becomes the "raw" adapter's session capture, or is subsumed into `src/engines/raw-adapter.ts`), `src/daemon/store.ts` (runs table columns), `tests/helpers/fake-claude.ts` (new). SP02 (code cleanup, Phase 2) will move the rest of the repo into `src/utils/`/`src/constants/` conventions this project establishes.

## TL;DR

Today `buildPromptRunCommand()` treats every engine identically: concatenate CLI args, spawn, regex-scrape a session id out of the last 128 KB of stdout/stderr. Post-ADR-0028 (Copilot plugin removed, prompt-only pivot) this has no engine-specific logic left at all. This PRD introduces a template-method `EngineAdapter` framework (design-principles.md #1): `RawAdapter` (today's generic behavior, for custom/unknown CLIs) and `ClaudeAdapter` (new). The Claude adapter pre-assigns session ids itself (no scraping), parses `stream-json` output for cost/tokens/turns/session id, and determines success from `is_error` + exit code. Runs gain `costUsd`, `turns`, `usageJson`, `transcriptPath`. Default engine becomes `claude`.

## Problem

- Session id capture is a best-effort regex against noisy stdout; it was already fragile enough that ADR 0028 stripped the Copilot-specific pattern and left only a generic placeholder explicitly flagged "expected to be redesigned, not extended."
- No usage/cost/token data is ever parsed — tenet 5 (usage-aware) is unimplemented for every engine.
- The core (`src/config.ts`, `src/daemon/runner.ts`) has no seam for engine-specific behavior; adding real Claude Code support today means `if (engine === 'claude')` branches, which design-principles.md #1 explicitly forbids.
- `BUILT_IN_CONFIG.defaultEngine` is still `copilot`, a CLI this project no longer ships a distribution mechanism for.

## Goals / Non-Goals

**Goals:** pluggable adapter contract + registry; a Claude Code adapter that is session-aware and usage-aware; a generic `raw` adapter preserving current behavior for non-Claude CLIs; run-record/storage delta; surface parity for the new fields; a fake-binary test strategy.

**Non-goals:** Copilot/Codex adapters (future SP, contract only needs to support them later); daemon reboot autostart; Claude Agent SDK integration (new runtime dep — see Decisions); rewriting unrelated modules (SP02).

## Requirements

| # | Requirement |
|---|---|
| R1 | `EngineConfigSchema` gains `type: z.enum(['claude','raw']).default('raw')`. Unset `type` resolves to `raw` — no behavior change for existing custom engines. |
| R2 | `BUILT_IN_CONFIG.defaultEngine` becomes `claude`; a built-in `claude` entry (`{ command: 'claude', args: [], env: {}, type: 'claude' }`) is added. `copilot` stays defined (`type: raw`) but is no longer default. **[Manual step: owner sign-off — breaking default-engine change.]** |
| R3 | Every Claude run gets a crontick-assigned session id up front (`randomUUID()` before spawn), persisted to `run.sessionId` immediately — not scraped after the fact — even when `reuseSession=false` (tenet 4 for every run, not just multi-turn ones). |
| R4 | `run` gains: `costUsd?: number`, `turns?: number`, `usageJson?: string` (redacted raw `usage` block), `transcriptPath?: string` (pointer to `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, never read as primary data), `engineStatus?: string` (Claude's `subtype`). `RawAdapter` runs leave these absent. |
| R5 | Claude success rule: `exitCode===0 && !result.is_error` → `success`; `exitCode===0 && result.is_error` → `failed` with `error` from `result.result`/`subtype` — a **new**, adapter-scoped failure mode (today exit 0 always means success unconditionally). `RawAdapter` keeps the existing exit-code-only table. |
| R6 | `runs get` / `stats summary` / `stats job` (existing capabilities — no new `SURFACE_CAPABILITIES` row) surface the new fields across CLI, MCP, library; `docs/reference/` updated. |
| R7 | Reserved-arg validation (`src/prompt-runtime.ts`) adds `--output-format`, `--settings` to its one static, engine-agnostic list (Decision 7) — both crontick-managed for every engine. |
| R8 | A resume against a pre-assigned session id that never produced a completed run (crash before first write) fails loudly with new code `CLAUDE_RESUME_FAILED`, rather than silently starting fresh. |
| R9 | **Argument passthrough** (resolves [OPEN] permission mode): `jobs new`/`jobs update` capture any long-form flag crontick doesn't itself recognize -- with or without a preceding `--` -- and append it verbatim, in argv order, to the existing `action.args: string[]` (no new field), alongside the `--`/`--arg` sources (ADR 0018/0019, unchanged, still mutually exclusive with each other; passthrough is an independent third source). The reserved-arg check (`src/prompt-runtime.ts`) runs against the merged `args` regardless of source, so a passthrough flag matching `RESERVED_PROMPT_ARGS` (extended per R7) is rejected, not silently accepted. |
| R10 | `JobSchema` gains a cross-field refinement: `action.reuseSession === true` requires `overlap === 'skip'`; `'queue'`/`'cancel-previous'` are rejected with a `VALIDATION_ERROR`. Schema-enforced, deliberately a single allowed value today, written so a future value can be added without changing its shape. |
| R11 | `ConfigSchema`/`PersistedConfigSchema` gain a `defaults` section (`overlap`, `timeoutSec`, `retry`), mirrored per the Persisted/effective split already used for `retention`/`logging`. `BUILT_IN_CONFIG.defaults` supplies the constants `job-input.ts` currently hardcodes (`overlap: 'skip'`, `retry: { max: 0, backoffSec: 30 }`, `timeoutSec: undefined`). |
| R12 | CLI flags renamed for boo-parity (Decision 15): `--alias` -> `--name`, `--engine` -> `--runner`, on `jobs new`/`jobs update`. Hard rename, no deprecated alias (design-principles.md #6; pre-1.0 per ADR 0027); underlying schema fields (`alias`, `action.engine`) are unchanged. |

## Architecture

**Adapter contract** (`src/engines/types.ts`), matching design-principles.md #1 exactly:

```ts
interface EngineOptions { runId: string; jobId: string; dataDir: string; sessionId?: string; reuseSession: boolean; args: string[]; env: Record<string,string>; }
interface EngineInvocation { command: string; args: string[]; env: Record<string,string>; }
interface EngineResult { status: 'success'|'failed'; exitCode?: number; error?: string; sessionId?: string; costUsd?: number; turns?: number; usage?: unknown; engineStatus?: string; }

abstract class EngineAdapter {
  abstract reservedArgs(): ReadonlySet<string>;
  abstract buildInvocation(prompt: string, opts: EngineOptions): EngineInvocation;
  abstract parseResult(exitCode: number|null, stdout: string, stderr: string): EngineResult;
  abstract resolveSessionId(opts: EngineOptions, result: EngineResult): string | undefined;
}
```

Registry (`src/engines/registry.ts`) maps `EngineConfig.type` → adapter (`raw`→`RawAdapter`, `claude`→`ClaudeAdapter`). `buildPromptRunCommand()` resolves the engine, looks up its adapter, delegates `buildInvocation`; `runner.ts`'s `close` handler delegates `parseResult`/`resolveSessionId` instead of its exit-code table + `extractSessionId()`. Core never inspects `engine.type` beyond the registry lookup.

**RawAdapter**: today's logic verbatim — `[command, ...args, prompt, ...actionArgs, --session-id=<id>?]`, exit-code-only `parseResult`, `extractSessionId()` regex scrape moved here unchanged.

**ClaudeAdapter** (`src/engines/claude-adapter.ts`):
- `buildInvocation`: `claude -p <prompt> --output-format stream-json --verbose <session-flag> ...actionArgs --settings <json>`. Session flag: `--session-id <uuid>` (fresh) when no `sessionId` yet, else `--resume <sessionId>` — never `--session-id` to resume `[verified: claude --help → --resume "resume a conversation by session ID"; --session-id "use a specific session ID"; --fork-session exists to opt OUT of resuming into the same id]`.
- Output format **stream-json**, not `json` (Decision 3): NDJSON lines flow through the existing `captureChunk`/redaction/128 KB-tail pipeline unchanged, no new capture code. `parseResult` scans the captured tail backwards for the last well-formed `"type":"result"` line (shape confirmed live: `session_id`, `total_cost_usd`, `usage`, `is_error`, `num_turns`, `duration_ms`, `result`, `subtype` `[verified: claude -p "..." --output-format json]`). If the cap truncated mid-line, or no result line ever appeared (crash/timeout), falls back to the exit-code table and leaves usage/cost empty.
- Timeout: crontick's own `timeoutSec`/SIGTERM stays authoritative, unchanged. `--max-budget-usd` (Claude's dollar cap) is not a new schema field — already passable via `action.args` (not reserved); documented as the recommended cost-cap mechanism.
- Permissions: **no flag added by default** (Decision 6). `args` is where a job opts into `--permission-mode acceptEdits`/`bypassPermissions` or `--allowedTools`.
- Completion-marker hook (Decision 9): `buildInvocation` always appends an ephemeral `--settings` JSON registering a `SessionEnd` hook (never touches the user's own `~/.claude/settings.json`) whose command writes `{exitStatus, sessionId}` to `<dataDir>/runs/<runId>.claude-hook.json`. On startup, `reconcileOrphanRuns()` checks for this marker before falling back to `ADOPTED_RUN_EXITED_MESSAGE`, closing the "exit unknown" gap for runs that finish while the daemon is down.

**Sequence (Claude, new session):** tick → run inserted `queued` → `Runner.spawn()` gets adapter from registry → adapter generates uuid, builds invocation → spawn (unchanged: `shell:false`, detached, pid persisted) → stdout/stderr stream through existing capture/redaction/cap pipeline → on `close`, adapter `parseResult` reads the tail, determines status/cost/turns/sessionId → `finalizeRun()` writes the new columns → if `reuseSession`, the already-known session id is written back onto the job via the existing compare-and-swap, without any scraping.

**Storage delta** (`src/daemon/store.ts`): `runs` gains `cost_usd REAL`, `turns INTEGER`, `usage_json TEXT`, `transcript_path TEXT`, `engine_status TEXT` — plain schema addition pre-1.0, no migration (ADR 0017).

**Argument passthrough** (`src/cli/index.ts`): `jobs new`/`jobs update` set `allowUnknownOption()`. Unknown tokens (a flag, plus its value if the next token isn't itself flag-shaped) are collected in argv order and merged with the `--`/`--arg` sources inside `resolveActionArgs()` (`src/job-input.ts`), before the ADR-0019 mutual-exclusion check and reserved-arg validation both run against the merged list. Library/MCP callers already pass `action.args: string[]` directly with no argv ambiguity, so passthrough is a CLI-shim-only concern.

**Config defaults resolution** (`src/config.ts`, `src/job-input.ts`): CLI flag > per-job JSON (an omitted update flag leaves the stored value untouched, as today) > `config.json` `defaults.*` > `BUILT_IN_CONFIG.defaults`. Resolved once at create/update time in `job-input.ts` — the same place `applyConfigDefaults()` already resolves `action.engine` — and snapshotted into the job file rather than re-resolved live, matching the existing `defaultEngine` precedent and keeping a later `config.json` edit from silently changing existing jobs (tenet 11).

## Decisions

| # | Decision | Choice | Alternatives considered | Why |
|---|---|---|---|---|
| 1 | Adapter selection key | New `engine.type` field | Infer from `command` basename | Basename-matching breaks the moment a user renames/wraps the binary |
| 2 | Keep a generic adapter | Yes — `RawAdapter` = today's behavior, default for unset `type` | Require every engine to declare a real adapter | Preserves custom-CLI configs unchanged; matches "engine-agnostic, not Claude-only" tenet |
| 3 | Output format | `stream-json` | `json` (simpler, one final object) | Fits the existing byte-capped stdout pipeline with zero new capture code, survives partial/killed runs, gives progress visibility in `runs logs`; cost is more parsing + higher byte volume, both absorbed by the existing cap |
| 4 | Session id sourcing | Crontick pre-assigns via `--session-id <uuid>` | Keep `extractSessionId()` for Claude too | Eliminates `SESSION_ID_NOT_FOUND` entirely for Claude; id known even if the process crashes before any output |
| 5 | Success determination | `exitCode===0 && !is_error` for Claude; exit-code-only for `RawAdapter` | Exit-code-only everywhere (today's rule) | Claude can exit 0 on a turn-limited/refused run; without this, a real failure silently records `success` |
| 6 | Default permission mode | **[RESOLVED]** No flag added by any adapter, ever; a job opts into unattended tool use via passthrough (e.g. `--dangerously-skip-permissions`) | Default to `bypassPermissions`; a crontick-level permission abstraction | Tenet 9 (safe by default): crontick never grants elevated permissions itself; one mechanism (passthrough) works for every current/future engine |
| 7 | Reserved-arg validation stays static | Extend the one engine-agnostic list (add `--output-format`, `--settings`) | Per-adapter `reservedArgs()` at schema-validation time | Schema validation is pure/zod-only, no config I/O; per-adapter sets would need config loaded inside a refinement — bigger change, out of scope |
| 8 | New default engine | `claude`, built-in | Keep `copilot` default | Matches "Claude Code is first-class" mandate. **[Manual step]** breaking change, needs owner sign-off (R2) |
| 9 | Hooks for restart recovery | Adopt: `SessionEnd` hook via ephemeral `--settings` writes a completion-marker file the daemon checks before "exit unknown" | Rely solely on process-liveness polling (today) | Fixes the one restart gap in the initiative brief; filesystem-only, no daemon-up dependency, no new runtime dep |
| 10 | Claude Agent SDK | Reject for this phase; keep CLI-subprocess model | `@anthropic-ai/claude-agent-sdk` in-process | New runtime dependency (AGENTS.md rule 1); would special-case Claude at the transport level, against the CLI-adapter contract Copilot/Codex must also fit. **[OPEN]** revisit if CLI capture proves too fragile |
| 11 | Concurrency with a resumed session | **[RESOLVED]** A reused session's in-flight run is never canceled; `reuseSession: true` requires `overlap: 'skip'` (R10) — the new fire is skipped and recorded via today's `overlap='skip'` mechanism verbatim (`status: 'canceled'`), no runner.ts change | Document-only (previous choice); allow `cancel-previous`+`reuseSession` | Canceling mid-turn could corrupt/orphan the reused session; `skip` is the one value that can't, so it's the only one allowed until a richer policy is designed |
| 12 | Passthrough conflicts | A passthrough/`--`/`--arg` token matching `RESERVED_PROMPT_ARGS` (R7) is **rejected**, same error as today's reserved-arg check | Let the user's flag win | Silently overriding e.g. `--output-format` breaks output parsing in a way that fails opaquely at run time, not at creation |
| 13 | Passthrough capture mechanism | Commander `allowUnknownOption()` + merge into `action.args`, preserving argv order | Custom argv pre-scan bypassing Commander | Smallest change; order preservation is all verbatim forwarding needs — crontick never needs a passthrough flag's arity |
| 14 | Config precedence + persistence | CLI flag > per-job JSON > `config.json` `defaults.*` > `BUILT_IN_CONFIG.defaults`, resolved once and **snapshotted** at create/update time | Store only the override; re-resolve `config.json` at every run | Matches the existing `defaultEngine` precedent exactly; re-resolving live would mean a `config.json` edit retroactively changes existing jobs (violates tenet 11) |
| 15 | CLI flag renames | `--alias` → `--name`, `--engine` → `--runner` (CLI-only; schema fields unchanged) | Keep both old and new as aliases | Matches the owner's stated CLI shape and boo-parity; a kept-alongside alias is dead weight (design-principles.md #6) |

### Borrowed from boo

[boo](https://github.com/briananderson1222/boo) is a Rust cron-for-agents tool with the same shape (schedule + prompt + engine "runner"). Only basic-input ideas were considered (owner: customization comes later).

| Idea | Boo's approach | crontick adoption |
|---|---|---|
| Schedule vocabulary (`--cron`/`--at`/`--every`) | Same three flags, mapped to recurring/one-shot/interval | **Already adopted** — matches; no change |
| Named jobs (`--name`) | Required, unique, primary identifier | **Adapt** — rename `--alias`→`--name` (R12); `alias` field stays optional/auto-generated |
| Engine selection (`--runner`) | Fixed per-engine adapter (`kiro`/`claude`/`codex`/...) | **Adapt** — rename `--engine`→`--runner` (R12); adapter concept unchanged |
| `config.json` with CLI paths + numeric defaults | `default_timeout_secs`, `max_log_runs`, per-CLI paths | **Adopt** — extend existing `config.json` with a `defaults` section (R11) |
| Generic flag/arg passthrough | **None** — a small fixed map (`--model`/`--trust-all-tools`/`--trust-tools`/`--agent`) translated per runner | **Reject** the fixed-mapping model; adopt open-ended unknown-flag passthrough (R9) — a fixed map needs a code change per engine per flag |
| Permission flags (`--trust-all-tools`→ e.g. `--dangerously-skip-permissions`) | Generic trust flag translated per engine | **Reject** — no permission abstraction; user passes the real flag via passthrough (Decision 6) |
| Working directory (`--dir`, per-job workspace default) | Always set | **Defer** — existing `action.cwd` already covers this |
| Natural-language `--at` (`"tomorrow 3pm"` via an agent) | Shells out to the job's runner CLI to parse free text | **Defer** — a dependency/complexity increase outside "basic inputs"; `--at` stays ISO-8601-only |
| Raw shell runner (`--runner shell`/`--command`) | Arbitrary shell command, no AI | **Reject** — crontick is prompt-only (ADR 0028), a stated non-goal |

## Manual steps

- Owner sign-off on `BUILT_IN_CONFIG.defaultEngine` changing from `copilot` to `claude` (R2/Decision 8) — breaking, allowed pre-1.0 (ADR 0027), needs explicit confirmation per AGENTS.md rule 8/4.
- Live spike verifying the `SessionEnd` hook fires reliably in `-p` mode and confirming its payload shape — not derivable from `claude --help` alone.

## Risks / Open Questions

- **[OPEN]** Exact `SessionEnd`/`Stop` hook firing semantics and payload in `-p` mode — adopted in principle, not fully verified.
- **[OPEN]** Behavior when `--resume <uuid>` targets a session that never had a first write (crash before any output) — R8 mandates a loud failure, but the actual Claude CLI error text/exit code is unverified.
- **[DEFERRED]** Claude Agent SDK adoption (Decision 10) — revisit only if CLI subprocess parsing proves fragile in production.
- **[RESOLVED]** stream-json vs json (Decision 3); session id pre-assigned, not scraped (Decision 4); default permission mode — no crontick-level flag, ever (Decision 6); `cancel-previous`+`reuseSession` — blocked at schema level (Decision 11); config precedence and persistence (Decision 14); CLI flag renames (Decision 15).

## Acceptance Criteria

- [ ] `EngineAdapter`/registry exist under `src/engines/`; `RawAdapter` reproduces all current `tests/prompt-session.test.ts`/`tests/config.test.ts` behavior unchanged.
- [ ] `ClaudeAdapter` builds correct argv for new-session and resume cases; unit-testable without spawning a real `claude` binary via a fake binary (`tests/helpers/fake-claude.ts`) emitting realistic `stream-json` lines (init line, assistant lines, final `result` line) with configurable exit code/`is_error`/delay.
- [ ] Run record surfaces `costUsd`, `turns`, `usageJson`, `transcriptPath`, `engineStatus` across CLI (`runs get`), MCP (`crontick_run_get`), and library; `tests/surface-drift.test.ts` still passes (no new capability rows needed).
- [ ] `BUILT_IN_CONFIG.defaultEngine === 'claude'`; `docs/specs/007-prompt-jobs.md` and `docs/reference/` updated; changeset added.
- [ ] A run whose Claude process exits 0 with `is_error: true` in its result line is recorded `failed`, not `success`.
- [ ] A completion-marker file, when present, overrides `ADOPTED_RUN_EXITED_MESSAGE` on daemon restart reconciliation.
- [ ] `crontick jobs new --prompt "..." --allow-all` stores `--allow-all` in `action.args` and forwards it verbatim at run time; a passthrough flag colliding with `RESERVED_PROMPT_ARGS` is rejected at create/update time.
- [ ] `crontick jobs new --prompt "..." --reuse-session --overlap queue` is rejected; `--reuse-session` alone (defaulting to `overlap: skip`) succeeds, and a second fire while active is recorded `canceled` with today's `overlap=skip` message.
- [ ] `config.json` `defaults.overlap`/`defaults.timeoutSec`/`defaults.retry` are honored when a new job omits the matching CLI flag, and are snapshotted (unaffected by a later `config.json` edit).
- [ ] `crontick jobs new --name <n> --prompt <p> --runner claude --every 30m` works; `--alias`/`--engine` no longer appear in `--help`.
