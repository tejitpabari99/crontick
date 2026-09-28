---
status: approved
summary: Post-SP01 cleanup of scattered constants/helpers into src/constants+utils, trim obsolete tests, and rewrite the doc set for the prompt-only + Claude-engine end state
date: 2026-09-28
---

# PRD: Code cleanup + documentation rewrite

Repo/branch: `crontick`, `.worktrees/claude-engine`, `users/tejitpabari/claude-engine`
Depends on: SP01 (Engine framework + Claude adapter) — do not redesign `src/engines/`, `prompt-session.ts`, `runner.ts` prompt path, or engine config schema; document their final shape only.
Owns (files): `src/constants/*`, `src/utils/*`, `AGENTS.md`, `CLAUDE.md`, `README.md`, all of `docs/**` except files SP01 is actively editing mid-flight, `package.json#scripts.validate`, test files listed under Requirements #2.

## TL;DR

SP01 lands the Claude engine adapter; SP02 is the settling pass: consolidate scattered constants/helpers per `docs/tech/design-principles.md` (#2, #3), retire tests that no longer earn their keep, fix the `validate` script's build-before-test ordering bug, and rewrite `docs/` so it accurately describes the prompt-only, Claude-first product — collapsing duplication across concepts/internals/reference/specs where four layers say the same thing four times.

## Problem

The prompt-only pivot (ADR 0028, commits `664e241`/`bb2c5ea`/`12a14ad`) removed `script`/`exec` and the Copilot plugin, but:
- Docs (~50k words, `[verified: wc -w docs/**/*.md → 49,922]`) still describe removed surfaces: `README.md:5` claims "Classic script/exec jobs still exist"; `docs/architecture.md` documents a 3-kind `ActionSchema` and a deleted `plugin/` directory; `docs/examples/{cli,mcp}/README.md` ship `script`/`exec` job JSON `[verified: grep 'kind": "script"' docs/examples → 2 hits]`.
- `docs/tech/{mission,principles}.md` (new, `d8d3966`) aren't linked from `docs/README.md` or `AGENTS.md`'s documentation map — the rulebook is undiscoverable.
- Constants duplicated, not centralized: retention defaults (`100`, `2_000_000`, `30`) are hand-copied in `src/config.ts:63` and `src/schemas/config.ts:76`, and re-typed as literals in `config.test.ts` (3x) and `runner.test.ts` `[verified: grep '2_000_000' src tests → 8 hits/4 files]`.
- `sleep(ms)` copy-pasted verbatim in `lifecycle.ts:273`, `ensure.ts:488`, `runner.ts:821` — identical 3-line body `[verified: grep 'function sleep' src → 3 hits]`. No `src/utils/`/`src/constants/` exist yet, despite principles #2/#3 mandating them.
- `npm run validate` runs `test` before `build`, but ~10 test files load `dist/*` (`cli.test.ts`, `dashboard.test.ts`, `mcp.test.ts`, …) `[verified: grep -l 'dist/' tests/unit/*.test.ts → 10 files]` — fails on a clean checkout.
- `tests/unit/rebrand.test.ts` scans a `plugin/` root deleted by `664e241` `[verified: ls plugin → no such file]`, silently no-oping via try/catch — a guard that can never fire.
- Doc layers overlap heavily: `internals/executors.md` (2473w) and `specs/003-execution.md` (2355w) both describe three action kinds that are now one; `architecture.md` alone is 4289w and repeats `internals/daemon.md` (1611w) and `specs/004-daemon.md` (2244w).

## Goals / Non-Goals

**Goals**
- Centralize constants (`src/constants/`) and dedupe helpers (`src/utils/`) per design principles; tests import the same constants as source.
- Remove or narrow tests that guard nothing real anymore; fix the `validate` ordering bug.
- Produce a lean, accurate `docs/` describing the final prompt-only + engine-adapter (SP01) state; decide which of concepts/internals/reference/specs survive per topic instead of duplicating by default.
- Link `docs/tech/*` from `docs/README.md` and `AGENTS.md`.
- Rewrite `README.md` to drop script/exec framing.

**Non-Goals**
- Redesigning SP01-owned engine code, schemas, or the `EngineAdapter` contract itself — SP02 documents, doesn't design, that layer.
- Adding new runtime dependencies, or `ts-prune`/`knip` (unavailable via `npx --no-install`; not installed as devDeps) — dead-export detection here is grep/manual, not tool-based `[verified: npx --no-install ts-prune → "canceled, missing package"]`.
- Rewriting ADRs (append-only per `docs/decisions/README.md`); superseding, not editing, is the only touch allowed.

## Requirements

### 1. `src/constants/` and `src/utils/`

| New file | Moves in | From |
|---|---|---|
| `src/constants/retention.ts` | `DEFAULT_RUN_RETENTION_CAP=100`, `DEFAULT_MAX_OUTPUT_BYTES_PER_RUN=2_000_000`, `maxLogFiles=30` | `src/daemon/store.ts:137`, `src/daemon/runner.ts:26`, `src/schemas/config.ts:47-49,76`, `src/config.ts:63` (all four become one import) |
| `src/constants/daemon.ts` | `DEFAULT_STARTUP_TIMEOUT_MS`, `DEFAULT_HEALTH_TIMEOUT_MS`, `DEFAULT_LOCK_TIMEOUT_MS`, `POLL_MS`, `SSE_POLL_MS`, `ADOPTED_RUN_POLL_MS` | `src/daemon/ensure.ts:39-43`, `src/daemon/api.ts:29`, `src/daemon/runner.ts:45` |
| `src/constants/scheduler.ts` | `DEFAULT_ENUMERATE_FIRES_CAP=500` | `src/daemon/scheduler.ts:35` |
| `src/constants/job-input.ts` | `DEFAULT_MAX_PROMPT_FILE_BYTES` | `src/job-input.ts:137` |
| `src/utils/sleep.ts` | one `sleep(ms)` | dedupe `lifecycle.ts`, `ensure.ts`, `runner.ts` |

Each affected test (`config.test.ts`, `runner.test.ts`, `scheduler.test.ts`, `daemon.ensure.test.ts`) imports the constant instead of re-declaring the literal. Do not move `SURFACE_CAPABILITIES` (stays `src/surface.ts` per AGENTS.md) or engine-config defaults SP01 owns.

### 2. Test-suite audit

| Test | Verdict | Action |
|---|---|---|
| `rebrand.test.ts` | Scans deleted `plugin/` root; try/catch silently no-ops | Drop `'plugin'` from `roots`; keep the pattern checks (still a valid legacy-name guard) |
| `dashboard-command-removal.test.ts` | Still guards a real, current decision | Keep as-is |
| `autostart-removal.test.ts` | Still guards a real, current decision (ADR 0013) | Keep as-is |
| `*.ctd-NNN.test.ts` (13 files) | Numbered by an external ticket system with no in-repo index of what `ctd-NNN` means | Rename to descriptive names (file already has one, e.g. `runner.ctd-001.test.ts` → `runner.pid-capture.test.ts`); confirm via `git log` what each guards before renaming, don't drop coverage |
| `validate` script ordering | `test` runs before `build`; ~10 files need `dist/` | Reorder `package.json#scripts.validate` to `lint && typecheck && typecheck:examples && build && test && typecheck:examples:dist` |

### 3. Docs information architecture

Collapse four-layer duplication by deciding, per topic, which single layer owns it:

| Topic | Keep in | Delete/merge |
|---|---|---|
| Action kinds / execution | `docs/concepts/execution.md` (mental model) + `docs/reference/job-schema.md` (fields) | Fold `docs/internals/executors.md`'s implementation detail into `docs/internals/README.md`'s daemon module page or cut to what's non-obvious past the code; `specs/003-execution.md` keeps only the acceptance-criteria table, not prose already in concepts |
| Daemon lifecycle | `docs/concepts/daemon-lifecycle.md` | `docs/internals/daemon.md` and `specs/004-daemon.md` cross-reference concepts instead of restating demand-start/shutdown narrative |
| Architecture overview | `docs/architecture.md` stays the single ~1500-2000 word map; move deep prose (full route tables, full error-code family tables) to `reference/` | Trim `architecture.md` from 4289 to a components-and-links overview |
| Engine framework (SP01) | New `docs/internals/engines.md` (adapter contract, lifecycle hooks) + `docs/concepts/execution.md` update | Written by SP02 after SP01 lands, describing the shipped adapter, not designing it |

Style rules (section appended to `design-principles.md`): word budgets — `concepts/*` ≤800w, `internals/*` ≤900w, `reference/*` uncapped (lookup tables), `specs/*` ≤600w prose + acceptance table, `architecture.md` ≤2000w. Every doc states its audience and a non-duplication rule ("if it's in concepts, internals links, doesn't repeat").

Concrete fixes: `README.md:5` — remove "Classic script/exec jobs still exist"; drop the "Advanced: script & exec jobs" section; `docs/examples/{cli,mcp}/README.md` — replace `script`/`exec` example JSON with a second prompt-job variant; `architecture.md` — drop `plugin/` extension-point section, collapse `ActionSchema` table to one `prompt` kind, add SP01's engine-adapter section; `specs/{001,003,004,005,006,007}.md` — cut script/exec/Copilot-plugin references.

**SP01-consistency fixes (new field/behavior, not a redesign):** per SP01's shipped shape, `copilot` is gone as a built-in engine entirely (not merely non-default) — every doc that lists or exemplifies `copilot` as an available/default engine (`docs/reference/configuration.md`, `docs/concepts/jobs.md`, `docs/reference/glossary.md`, `docs/decisions/0008-prompt-jobs-pluggable-engines.md` stays untouched as an append-only ADR, but its still-current successors don't cite `copilot` as live) is updated to show `claude` as the sole built-in, with `copilot`-shaped custom-engine config left only as a generic `type: raw` example, unnamed. Every run-status enumeration in `docs/reference/` (errors, cli, mcp-tools, job-schema, library-api) and `docs/concepts/` (execution, state-and-storage) that lists `canceled` adds the new terminal `skipped` status (SP01 R13) with its distinguishing meaning ("never started" vs. "started, then terminated").

Link `docs/tech/mission.md`/`design-principles.md` from `docs/README.md` (new "Guiding docs" row), `AGENTS.md`'s documentation-map table, and `CLAUDE.md` (one line: "check `docs/tech/design-principles.md` before any structural change").

### 4. AGENTS.md / CLAUDE.md updates

- `AGENTS.md` "Source organization": add `src/constants/` and `src/utils/` rows with their one-line purpose.
- `AGENTS.md` "Implementation rules": add "Constants used in more than one file live in `src/constants/`; reusable logic lives in `src/utils/`" (mirrors design-principles #2/#3, doesn't restate the rationale).
- `AGENTS.md` documentation map: add `docs/tech/` row.
- Do not touch `.github/workflows/release.yml` (explicit CLAUDE.md restriction).

## Architecture

```
src/
  constants/
    retention.ts      # run/output/log retention defaults
    daemon.ts          # timeouts, poll intervals
    scheduler.ts        # enumerate-fires cap
    job-input.ts        # prompt-file size cap
  utils/
    sleep.ts           # single sleep(ms)
    (existing json-file.ts, paths.ts stay — already single-purpose, already exported)
```

`src/utils/` holds only pure, side-effect-free helpers, no business logic (design-principles #2); `src/config.ts` and `src/schemas/config.ts` both import from `src/constants/retention.ts` rather than each other, avoiding a config↔schema circular dependency.

Docs target (full mapping in Requirements #3): `architecture.md` (map) → `concepts/` (mental models) → `internals/` (implementation, links back to concepts) → `reference/` (lookup facts, no narrative) → `specs/` (acceptance criteria, trimmed prose) → `decisions/` (append-only, untouched). `docs/tech/` is the top-level entry point, linked from `docs/README.md` and `AGENTS.md`.

## Decisions

| # | Decision | Choice | Alternatives considered | Why |
|---|---|---|---|---|
| 1 | Constants grouping | Four domain files (`retention`, `daemon`, `scheduler`, `job-input`) | One flat `constants.ts` | Matches principles #3 "grouped by domain"; narrower import surfaces |
| 2 | `ctd-NNN` test renames | Rename to descriptive names, keep coverage, after a repo-wide `grep "ctd-0"` confirms no external ticket/dashboard reference (Risks) | Delete and rewrite | Descriptive name already present post-`ctd-NNN`; renaming is low-risk once the grep confirms no self-external references exist |
| 3 | Doc layer per topic | One layer owns narrative; others link, don't repeat | Merge concepts+internals into one folder | `docs/README.md`'s users-vs-maintainers audience split is real; fix is discipline, not fewer folders |
| 4 | `validate` fix | Reorder script (build before test) | Add `"pretest": "npm run build"` | `npm test` alone is documented as "requires prior build" (AGENTS.md); a silent `pretest` hook would contradict that documented contract |
| 5 | `plugin/` in rebrand test | Drop from scan roots | Leave (harmless no-op) | Dead reference to a directory moved to another branch; confuses future readers |

## Manual steps

- None — all changes are code/doc edits and test renames within this branch's scope.

## Risks / Open Questions

- [RESOLVED: review-only, no tooling] Word-budget enforcement is discipline, not a CI check — no word-count tooling/dependency added this pass. Revisit only if docs drift again in a later cleanup pass.
- [RESOLVED: decide during implementation, default rule stated] `docs/internals/executors.md` vs. `daemon.md`: implementer counts the words that are still unique (non-obvious past-the-code, non-duplicated-with-concepts) once script/exec content is cut. Default: if under ~150 words of unique content remain, merge that content into `daemon.md` and delete `executors.md`; otherwise keep it standalone, renamed `prompt-execution.md` to match the one remaining action kind. Either outcome satisfies Requirements #3's topic-ownership table — this only decides the file boundary.
- [RESOLVED: grep-first rule] `ctd-NNN` rename scope: before renaming any of the 13 files, run `grep -rn "ctd-0" . --include='*.md' --include='*.ts'` (repo-wide, including `docs/decisions/`) with the file-rename PR. If every hit is the test file's own name/self-reference, rename freely (Decision 2). If a hit is an external reference (a linked ticket/dashboard ID, a changelog entry, an ADR citing the number as a stable identifier), keep that one file's name and rename only the rest.
- [RESOLVED: SP01 boundary] SP02 does not touch `src/daemon/prompt-session.ts`, `runner.ts`'s prompt-building logic, or engine config schema — confirmed these are SP01-owned per the initiative split; SP02 only documents the shipped result.
- [DEFERRED] Introducing `ts-prune`/`knip` for automated dead-export detection — not available without a new dependency; manual grep-based audit only for this pass.

## Acceptance Criteria

- [ ] `grep -rn "kind: 'script'\|kind: 'exec'\|kind === 'script'" src docs README.md` → 0 hits outside `docs/decisions/` (historical ADRs may reference them).
- [ ] `grep -rln "copilot" docs/reference docs/concepts README.md` → 0 hits describing it as a live/default/available engine (outside `docs/decisions/`, append-only); `grep -rln "'skipped'\|skipped" docs/reference` → run-status tables list it.
- [ ] `grep -c "function sleep" src/daemon/*.ts` → 1 total (single `src/utils/sleep.ts`).
- [ ] `grep -rn "2_000_000\|maxRunsPerJob: 100" src/config.ts src/schemas/config.ts` → both import from `src/constants/retention.ts`, no duplicate literals.
- [ ] `ls src/constants src/utils` → both directories exist with the files listed in Architecture.
- [ ] `npm run validate` passes on a clean `git clean -fdx`-equivalent checkout (build runs before test).
- [ ] `grep -rn "plugin/" tests/unit/rebrand.test.ts` → 0 hits.
- [ ] All `docs/tech/*.md` links resolve from `docs/README.md` and `AGENTS.md` (manual link check, no broken relative paths).
- [ ] `wc -w docs/architecture.md` ≤ 2000.
- [ ] `npm run lint && npm run typecheck` pass with no unused-export lint errors introduced by the moves.
- [ ] `npm run build && npm run typecheck:examples:dist` pass (constants/utils moves don't break the public `dist/index.d.ts`).
