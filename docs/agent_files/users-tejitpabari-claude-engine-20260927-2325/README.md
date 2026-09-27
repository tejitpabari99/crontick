---
status: draft
summary: Design index for the Claude engine initiative — engine-adapter framework (SP01) and post-adapter cleanup/docs rewrite (SP02).
date: 2026-09-27
---

# Claude Engine Initiative — Design Index

## Sub-projects

| # | Name | Phase | Depends on | Status | Scope | Link |
|---|------|-------|------------|--------|-------|------|
| SP01 | Engine framework + Claude adapter | 1 | none | draft | Pluggable `EngineAdapter` contract/registry; session-aware, usage-aware `ClaudeAdapter`; `RawAdapter` preserves today's generic behavior; run-record + storage delta. | [01-claude-code-engine/PRD.md](01-claude-code-engine/PRD.md) |
| SP02 | Code cleanup + doc rewrite | 2 | SP01 | draft | Consolidate constants/helpers into `src/constants/`+`src/utils/`; audit/rename/trim tests; fix `validate` build-before-test ordering; rewrite `docs/` for the prompt-only + Claude-adapter end state. | [02-cleanup-and-docs/PRD.md](02-cleanup-and-docs/PRD.md) |

## Dependency graph

```
SP01 (engine framework) → SP02 (cleanup + docs)
```

SP02 documents SP01's shipped shape; it does not redesign `src/engines/`, `prompt-session.ts`, `runner.ts`'s prompt path, or the engine config schema.

## Locked decisions (initiative-wide)

- Prompt-only product, per ADR 0028 — no `script`/`exec` job kinds.
- The Copilot plugin is preserved, but only on branch `users/tejitpabari/copilot-init`, not on this branch.
- Claude Code is the first engine, delivered via a general adapter framework (not a Claude-only special case).
- Follow `docs/tech/design-principles.md` and `docs/tech/mission.md` for all structural decisions.
- No daemon reboot autostart (ADR 0013 stands).
- No new runtime dependencies (AGENTS.md rule 1) — CLI-subprocess model only, no Claude Agent SDK this phase.
- Pre-1.0: breaking changes are allowed without back-compat shims (ADR 0027), but still need explicit owner sign-off per AGENTS.md rule 8.

## Open items (owner action required)

**SP01 — Engine framework + Claude adapter**

- Default permission mode for unattended Claude runs unresolved (Decision 6): no flag added by default, so tool-using jobs may see silent permission denials in `-p` mode. Owner call needed.
- `SessionEnd`/`Stop` hook firing semantics and payload shape in `-p` mode adopted in principle but not verified live.
- Behavior when `--resume <uuid>` targets a session that crashed before any output is unverified (R8 mandates a loud `CLAUDE_RESUME_FAILED`, but actual CLI error text/exit code unconfirmed).
- Whether to hard-block `cancel-previous` + `reuseSession` combination at schema level, vs. document-only (Decision 11) — deferred.
- Claude Agent SDK adoption (Decision 10) deferred; revisit only if CLI-subprocess parsing proves fragile in production.
- Manual step: owner sign-off required for `BUILT_IN_CONFIG.defaultEngine` changing from `copilot` to `claude` (breaking, pre-1.0-allowed).

**SP02 — Cleanup + docs**

- Word-budget enforcement mechanism for docs (CI check vs. review-only) undecided; review-only recommended, no new tooling.
- Whether `docs/internals/executors.md` should be renamed or merged into `daemon.md` — depends on diff size once script/exec content is cut; decide during implementation.
- `ctd-NNN` test rename scope: must grep repo and `docs/decisions/` for literal `ctd-0` references before renaming, to confirm no external ticket/dashboard dependency.

---

Next: owner reviews PRDs, resolves [OPEN] items, then run dev-tasks.
