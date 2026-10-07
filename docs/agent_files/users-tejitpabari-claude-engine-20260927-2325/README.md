---
status: approved
summary: Design index for the Claude engine initiative — engine-adapter framework (SP01), cleanup/docs rewrite (SP02), CLI and job model (SP03), dashboard and daemon port (SP04), engine observability and QA (SP05).
date: 2026-09-28
---

# Claude Engine Initiative — Design Index

## Sub-projects

| # | Name | Phase | Depends on | Status | Scope | Link |
|---|------|-------|------------|--------|-------|------|
| SP01 | Engine framework + Claude adapter | 1 | none | done | Pluggable `EngineAdapter` contract/registry; session-aware, usage-aware `ClaudeAdapter`; `RawAdapter` preserves today's generic behavior; run-record + storage delta. | [01-claude-code-engine/PRD.md](01-claude-code-engine/PRD.md) |
| SP02 | Code cleanup + doc rewrite | 2 | SP01 | approved | Consolidate constants/helpers into `src/constants/`+`src/utils/`; audit/rename/trim tests; fix `validate` build-before-test ordering; rewrite `docs/` for the prompt-only + Claude-adapter end state. | [02-cleanup-and-docs/PRD.md](02-cleanup-and-docs/PRD.md) |
| SP03 | CLI and job model | 3 | SP01, SP02 | done | Alias as the single term (`<id\|alias>` everywhere, `-n`/`-p`/`-C`), per-job `--cwd` plus Claude trust check (`TRUST_REQUIRED`, `--trust-folder`), default `config.json`, `info` cleanup, `--tz` removed, delete removes runs, `runs get` absorbs `runs logs`/`runs output`, `stats job`, `jobs schedule` status, share export/import schema 1 (jobs only). | [03-cli-and-job-model/PRD.md](03-cli-and-job-model/PRD.md) |
| SP04 | Dashboard and daemon port | 3 | SP03 | done | Fixed daemon port 47615 (`CRONTICK_DAEMON_PORT`, occupied fallback, `daemon.port`), assistant-text-only run output with `---`, raw-log route, dashboard theme icons, full ids, Alias and Runner Session ID labels. | [04-dashboard-and-daemon/PRD.md](04-dashboard-and-daemon/PRD.md) |
| SP05 | Engine observability and QA | 3 | SP03 | done | Per-job `logFile` helper, display-only `usage` normalization, eval-free `SessionEnd` hook helper script, QA pass. | [05-engine-observability-qa/PRD.md](05-engine-observability-qa/PRD.md) |

## Dependency graph

```
SP01 (engine framework) → SP02 (cleanup + docs) → SP03 (CLI + job model) → SP04 (dashboard + daemon port), SP05 (observability + QA)
```

SP02 documents SP01's shipped shape; it does not redesign `src/engines/`, `prompt-session.ts`, `runner.ts`'s prompt path, or the engine config schema.

## Locked decisions (initiative-wide)

- Prompt-only product, per ADR 0002 — no `script`/`exec` job kinds.
- The Copilot plugin is preserved, but only on branch `users/tejitpabari/copilot-init`, not on this branch.
- Claude Code is the first engine, delivered via a general adapter framework (not a Claude-only special case).
- Follow `docs/tech/design-principles.md` and `docs/tech/mission.md` for all structural decisions.
- SP03-SP05 (all pre-1.0, one minor changeset each): one user-facing term, **alias** (`--name`/`-n`); every job argument is `<id|alias>`. Cron fires in machine local time (`--tz` removed). Deleting a job deletes its runs/logs; `runs logs`/`runs output` and their MCP tools are removed in favor of `runs get` (run + `logFile` + cleaned output). Share files are `schema: 1`, jobs only. Jobs run in a per-job cwd (default: invocation folder); Claude jobs need a trusted folder (`TRUST_REQUIRED`, `--trust-folder`). Default `config.json` is written automatically (precedence CLI > per-job > config.json > built-ins). Daemon prefers fixed port 47615 with a free-port fallback; run output is assistant text only (`---` between segments); the SessionEnd hook is a plain helper script (no eval/base64); the display label for `sessionId` is "Runner Session ID".
- No daemon reboot autostart (ADR 0001 stands).
- No new runtime dependencies (AGENTS.md rule 1) — CLI-subprocess model only, no Claude Agent SDK this phase.
- Pre-1.0: breaking changes are allowed without back-compat shims (ADR 0001), but still need explicit owner sign-off per AGENTS.md rule 8.
- No crontick-managed permission flags, ever — any engine permission mode is passed by the user via argument passthrough (any CLI flag crontick doesn't recognize is forwarded verbatim to the engine; see SP01 Decision 6/R9).
- A job with `reuseSession: true` may only use `overlap: 'skip'` (schema-enforced); a fire while the reused session's run is active is recorded with a new terminal status `skipped` (not `canceled`) — applies to every overlap-skip, not only reused-session ones — and never cancels the in-flight run (SP01 Decision 11/16/R10/R13).
- `config.json` gains a `defaults` section (overlap, timeout, retry) for job-setting defaults; precedence is CLI flag > per-job JSON > `config.json` > built-in constants, resolved and snapshotted once at create/update time — a later `config.json` edit never retroactively changes an existing job (SP01 Decision 14/R11, **[RESOLVED]**).
- CLI flags renamed for boo-parity: `--alias`→`--name`, `--engine`→`--runner` (SP01 Decision 15/R12; hard rename, no back-compat alias).
- `claude` is the sole built-in engine; `copilot` is removed entirely from `BUILT_IN_CONFIG`/`EngineConfigSchema`, not merely demoted from default (SP01 Decision 8/R2, owner-approved, no manual sign-off needed). SP02's doc rewrite drops `copilot` as a live/example engine everywhere outside append-only ADRs.
- `--resume <sessionId>` is only ever attempted for a session id captured from a prior run that actually completed (`success`/`failed`), and only after a preflight check that its transcript file (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`) exists; a miss fails fast with `SESSION_NOT_FOUND` before spawning, and spawn's stdin is `'ignore'`'d as defense in depth — Claude's own interactive resume-picker for an unrecognized id can otherwise hang a TTY-less daemon child until timeout (SP01 Decision 17/R8, owner-observed live behavior).

## Open items

**None.** SP01 and SP02 PRDs are approved with zero `[OPEN]` items (`grep -n "\[OPEN\]"` on both returns nothing). What remains is either resolved-with-a-concrete-design or explicitly deferred to a later, non-blocking point:

**SP01 — Engine framework + Claude adapter**

- Resolved this revision: default permission mode (no crontick flag, ever — argument passthrough instead); `cancel-previous`+`reuseSession` (blocked at schema level, forced to `overlap: 'skip'`); config precedence, snapshotted at create/update (Decision 14); CLI flag renames (Decision 15); new terminal run status `skipped` for every overlap-skip, distinct from `canceled` (Decision 16/R13); resume-target safety — preflight transcript-file check, eligible-session filter, `stdin:'ignore'`, fail fast with `SESSION_NOT_FOUND` before spawning (Decision 17/R8); `copilot` removed entirely, `claude` sole built-in engine, owner-approved, no manual sign-off (Decision 8/R2).
- **[DEFERRED]** `SessionEnd`/`Stop` hook firing semantics and payload shape in `-p` mode: implemented per current best understanding as a best-effort supplement to restart reconciliation only — the exit-code/stream-json path (R5) is the primary, hook-independent signal for every normal-run outcome. Owner validates the hook live after SP01 lands.
- **[DEFERRED]** Claude Agent SDK adoption (Decision 10) — revisit only if CLI-subprocess parsing proves fragile in production.

**SP02 — Cleanup + docs**

- Resolved this revision: word-budget enforcement is review-only, no new CI tooling; `docs/internals/executors.md` rename-vs-merge decided during implementation by a stated word-count rule (merge into `daemon.md` if <~150 words of unique content remain, else rename to `prompt-execution.md`); `ctd-NNN` renames gated on a repo-wide `grep "ctd-0"` first, keeping any file an external reference is found for.
- **[DEFERRED]** Introducing `ts-prune`/`knip` for automated dead-export detection — no new dependency this pass; manual grep-based audit only.

---

Next: SP01 to SP05 are implemented on this branch; remaining work is release (see `../futures.md`).
