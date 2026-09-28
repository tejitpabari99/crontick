---
status: draft
summary: Post-SP01 cleanup — centralize constants/utils, audit tests, fix validate ordering, and rewrite docs for the prompt-only + Claude-engine end state
date: 2026-09-28
---

# Tasks: Code cleanup + documentation rewrite (SP02)

Source of truth: `docs/agent_files/users-tejitpabari-claude-engine-20260927-2325/02-cleanup-and-docs/PRD.md`. All tasks below additionally depend on SP01 (Engine framework + Claude adapter) being complete and merged — SP02 documents SP01's shipped shape and must not redesign `src/engines/`, `prompt-session.ts`, `runner.ts`'s prompt path, or the engine config schema.

| # | Task | Depends on | Status |
|---|---|---|---|
| 1 | Centralize retention/daemon/scheduler/job-input constants and dedupe `sleep()` | none | todo |
| 2 | Fix `validate` script ordering and drop dead `plugin/` scan from `rebrand.test.ts` | none | todo |
| 3 | Rename `ctd-NNN` test files to descriptive names | none | todo |
| 4 | Rewrite `README.md` and doc examples to drop script/exec framing | none | todo |
| 5 | Restructure docs information architecture (architecture, concepts, internals, specs) | 4 | todo |
| 6 | Apply SP01-consistency fixes across docs (copilot removal, `skipped` status) | 5 | todo |
| 7 | Update `AGENTS.md`/`CLAUDE.md`/`docs/README.md` for new structure and tech-doc links | 1, 5, 6 | todo |

## Task 1 — Centralize constants and dedupe `sleep()`

What it is / what it means: Design principles #2/#3 require grouped constants and deduped pure helpers, but retention/daemon/scheduler/job-input values are hand-copied across `src/config.ts`, `src/schemas/config.ts`, `src/daemon/store.ts`, `src/daemon/runner.ts`, `src/daemon/ensure.ts`, `src/daemon/api.ts`, `src/daemon/scheduler.ts`, `src/job-input.ts`, and `sleep(ms)` is copy-pasted three times.

What changes at a high level: Create `src/constants/retention.ts`, `daemon.ts`, `scheduler.ts`, `job-input.ts` per the PRD's Architecture mapping, and `src/utils/sleep.ts` with a single `sleep(ms)` implementation. Update every listed source file plus `config.test.ts`, `runner.test.ts`, `scheduler.test.ts`, `daemon.ensure.test.ts` to import the shared constant/util instead of re-declaring literals. `src/config.ts` and `src/schemas/config.ts` both import from `retention.ts` rather than each other, avoiding a config↔schema cycle. Do not touch `src/surface.ts` or SP01-owned engine-config defaults.

Done when: `ls src/constants src/utils` shows the new files; `grep -c "function sleep" src/daemon/*.ts` → 1 total; `grep -rn "2_000_000\|maxRunsPerJob: 100" src/config.ts src/schemas/config.ts` shows only imports, no duplicated literals; `npm run lint && npm run typecheck && npm run build && npm run typecheck:examples:dist && npm test` all pass.

## Task 2 — Fix `validate` ordering and drop dead `plugin/` scan

What it is / what it means: `npm run validate` runs `test` before `build`, but ~10 test files load `dist/*` and fail on a clean checkout (Decision 4). Separately, `tests/unit/rebrand.test.ts` scans a `plugin/` root deleted by the prompt-only pivot, silently no-oping via try/catch (Decision 5).

What changes at a high level: Reorder `package.json#scripts.validate` to `lint && typecheck && typecheck:examples && build && test && typecheck:examples:dist`. In `rebrand.test.ts`, drop `'plugin'` from the scan roots while keeping the legacy-name pattern checks intact — do not add a `pretest` hook (rejected alternative per Decision 4).

Done when: `npm run validate` passes on a clean `git clean -fdx`-equivalent checkout with build running before test; `grep -rn "plugin/" tests/unit/rebrand.test.ts` → 0 hits; the rebrand pattern assertions still run and pass.

## Task 3 — Rename `ctd-NNN` test files

What it is / what it means: 13 test files are numbered by an external ticket system with no in-repo index of what `ctd-NNN` means, even though each file already has a descriptive name available (e.g. `runner.ctd-001.test.ts` → `runner.pid-capture.test.ts`). Decision 2 and the corresponding Risk resolve this as a rename, gated by a repo-wide grep so no external reference is silently broken.

What changes at a high level: Run `grep -rn "ctd-0" . --include='*.md' --include='*.ts'` across the repo (including `docs/decisions/`) before renaming anything. If every hit is a file's own name/self-reference, rename all 13 freely to their descriptive names, confirming via `git log` on each file what it actually guards so no coverage is lost in the rename. If any hit is an external reference (a linked ticket/dashboard ID, changelog entry, or ADR citing the number as a stable identifier), keep that one file's `ctd-NNN` name and rename only the rest.

Done when: The grep was run and its output (or absence of external hits) is recorded in the commit message; all safely-renamable files are renamed with no loss of test coverage; `npm test` passes with the same or greater number of passing test cases as before the rename.

## Task 4 — Rewrite `README.md` and doc examples for prompt-only

What it is / what it means: `README.md:5` still claims "Classic script/exec jobs still exist" and ships an "Advanced: script & exec jobs" section; `docs/examples/{cli,mcp}/README.md` ship `script`/`exec` job JSON. These describe surfaces removed by ADR 0028.

What changes at a high level: Remove the script/exec claim and section from `README.md`. Replace the `script`/`exec` example JSON in `docs/examples/cli/README.md` and `docs/examples/mcp/README.md` with a second prompt-job variant each, so the examples still show two job shapes without referencing removed kinds.

Done when: `grep -rn "kind: 'script'\|kind: 'exec'\|kind === 'script'" README.md docs/examples` → 0 hits; `grep -n 'script": "2 hits'` style script/exec job JSON in `docs/examples` → 0 hits; both example READMEs still demonstrate two distinct prompt-job configurations.

## Task 5 — Restructure docs information architecture

What it is / what it means: `docs/architecture.md` (4289w), `docs/internals/executors.md` (2473w), and `docs/specs/003-execution.md` (2355w) all describe the same now-single `prompt` action kind, and `architecture.md` still documents a 3-kind `ActionSchema` and a deleted `plugin/` extension-point section. Decision 3 and Requirement #3's topic-ownership table assign exactly one narrative owner per topic; others link instead of repeating.

What changes at a high level: Trim `docs/architecture.md` to a ~1500-2000 word components-and-links map: drop the `plugin/` extension-point section, collapse the `ActionSchema` table to the one `prompt` kind, add a new section describing SP01's shipped engine-adapter framework, and move deep prose (full route tables, error-code family tables) into `reference/`. Keep `docs/concepts/execution.md` as the execution mental model and `docs/reference/job-schema.md` as the field lookup. For `docs/internals/executors.md`: count the words that remain unique (non-obvious past-the-code, not duplicated with concepts) after script/exec content is cut — if under ~150 words remain, merge that content into `docs/internals/daemon.md` and delete `executors.md`; otherwise keep it standalone, renamed `docs/internals/prompt-execution.md` (Risk resolution). Make `docs/internals/daemon.md` and `docs/specs/004-daemon.md` cross-reference `docs/concepts/daemon-lifecycle.md` instead of restating the demand-start/shutdown narrative. Trim `docs/specs/{001,003,004,005,006,007}.md` to acceptance-criteria tables plus ≤600w prose each, cutting script/exec/Copilot-plugin references. Add a new `docs/internals/engines.md` describing SP01's shipped adapter contract and lifecycle hooks (documentation only, no design changes). Append the word-budget style rules (concepts ≤800w, internals ≤900w, reference uncapped, specs ≤600w prose + table, architecture.md ≤2000w; every doc states its audience and a non-duplication rule) to `docs/tech/design-principles.md`. Update `docs/README.md`'s index for every file added, renamed, or removed in this task.

Done when: `wc -w docs/architecture.md` ≤ 2000; `grep -rn "kind: 'script'\|kind: 'exec'\|kind === 'script'" docs` → 0 hits outside `docs/decisions/`; `docs/internals/executors.md` either no longer exists (merged into `daemon.md`) or is renamed `prompt-execution.md`, not both; `docs/internals/engines.md` exists and describes the shipped adapter; every doc in `docs/concepts/`, `docs/internals/`, `docs/specs/` is at or under its word budget; `docs/README.md` has no dead links to renamed/removed files.

## Task 6 — Apply SP01-consistency fixes across docs

What it is / what it means: Per SP01's shipped shape, `copilot` is removed entirely as a built-in engine (not merely non-default), and a new terminal run status `skipped` exists alongside `canceled`. Every doc that still lists or exemplifies `copilot` as available/default, or enumerates run statuses without `skipped`, is now stale.

What changes at a high level: Update `docs/reference/configuration.md`, `docs/concepts/jobs.md`, and `docs/reference/glossary.md` so `claude` is shown as the sole built-in engine; leave `docs/decisions/0008-prompt-jobs-pluggable-engines.md` untouched (append-only ADR) but ensure any still-current successor doc doesn't cite `copilot` as live — a `copilot`-shaped example may remain only as a generic, unnamed `type: raw` custom-engine illustration. Add the `skipped` status, with its distinguishing meaning ("never started" vs. "started, then terminated"), to every run-status enumeration in `docs/reference/{errors,cli,mcp-tools,job-schema,library-api}.md` and `docs/concepts/{execution,state-and-storage}.md` that currently lists `canceled`.

Done when: `grep -rln "copilot" docs/reference docs/concepts README.md` → 0 hits describing it as a live/default/available engine (ADR files excluded); `grep -rln "skipped" docs/reference` → the run-status tables in errors, cli, mcp-tools, job-schema, and library-api all list it with its distinguishing meaning.

## Task 7 — Update `AGENTS.md`/`CLAUDE.md`/`docs/README.md` for structure and links

What it is / what it means: `AGENTS.md`'s "Source organization" table has no rows for the new `src/constants/`/`src/utils/` directories (Task 1), its "Implementation rules" don't yet state the constants/utils convention, its documentation map lacks a `docs/tech/` row, and `docs/tech/mission.md`/`design-principles.md` aren't linked from `docs/README.md` or `AGENTS.md` — the rulebook is undiscoverable (Requirement #3/#4).

What changes at a high level: Add `src/constants/` and `src/utils/` rows with one-line purposes to `AGENTS.md`'s "Source organization" table. Add an implementation rule: "Constants used in more than one file live in `src/constants/`; reusable logic lives in `src/utils/`" (mirrors design-principles #2/#3, no rationale restated). Add a `docs/tech/` row to `AGENTS.md`'s documentation map. Add a "Guiding docs" row linking `docs/tech/mission.md` and `docs/tech/design-principles.md` from `docs/README.md`. Add one line to `CLAUDE.md`: check `docs/tech/design-principles.md` before any structural change.

Done when: `AGENTS.md`'s Source organization table lists `src/constants/` and `src/utils/`; the new implementation rule and `docs/tech/` doc-map row are present; `docs/README.md` links both `docs/tech/*` files and both links resolve to real files; `CLAUDE.md` contains the design-principles check line.

## Closing note

No manual/human-only steps — the PRD's Manual steps section states all changes are code/doc edits and test renames within this branch's scope.
