# Design Principles

Rules every design and implementation in crontick must follow. This is a **living doc** — reviewers check PRs against it, and it should be updated (with an ADR where it's a lasting decision) whenever a real change forces a rule to move.

## 1. Common engine framework, engine-specific adapters

Every engine (Claude Code, Copilot, Codex, ...) has its own CLI flags, output format, session model, and session management commands — but the *lifecycle* is identical for all of them: build invocation → start session → track it → detect completion → extract session id / result / usage → record the run.

**Rationale:** if the core branches on engine name, every new engine is a core change and a source of drift. A fixed lifecycle with pluggable steps keeps the core stable as engines are added.

The core owns the lifecycle and calls well-defined hook methods; each engine is a derived class/adapter that overrides only what differs for it — e.g. `buildInvocation(prompt, opts)`, `resolveSessionId(...)`, `parseResult(output)`, `resumeArgs(sessionId)`. This is template-method / strategy style: the core never asks "which engine is this?" in the middle of a lifecycle step.

- **Do** add an engine by adding one adapter and registering it.
- **Do** keep every engine-specific quirk (flag order, output parsing, session resume syntax) inside that engine's adapter.
- **Don't** add `if (engine === 'claude') { ... }` branches anywhere in the core lifecycle.
- **Don't** let one adapter's needs (e.g. a flag format) leak into the shared hook signatures other adapters must also implement.

```ts
abstract class EngineAdapter {
  abstract buildInvocation(prompt: string, opts: EngineOptions): Invocation;
  abstract resolveSessionId(output: EngineOutput): string | undefined;
  abstract parseResult(output: EngineOutput): EngineResult;
  abstract resumeArgs(sessionId: string): string[];
}
```

## 2. Work modular

Anything that can be a standalone, reusable function should be one.

**Rationale:** modular helpers are independently testable and stop the same logic getting reimplemented (and re-diverging) in two places.

Shared helpers live in `src/utils/` — one concern per file, pure where possible, unit-tested.

- **Do** extract a helper as soon as a second call site needs the same logic.
- **Do** keep each `src/utils/` file scoped to one concern (e.g. redaction, path resolution, time formatting) rather than a catch-all `helpers.ts`.
- **Don't** copy-paste logic across modules "just this once."
- **Don't** put business logic in a util — utils are pure support, not decision-makers (see Principle 4, Single core / thin shims).

## 3. Constants in one place

All constants — especially anything used in more than one file, including tests — plus default config values live in `src/constants/`, grouped by domain (e.g. `src/constants/daemon.ts`, `src/constants/engines.ts`).

**Rationale:** a magic number duplicated between source and test can drift silently; a test that imports the same constant as the source it tests can't drift from it.

- **Do** add a new domain file under `src/constants/` when an existing one doesn't fit.
- **Do** have tests import the constant, not re-declare its value.
- **Don't** inline a literal (timeout, retry count, default port, etc.) that appears, or is likely to appear, in more than one file.

## Proposed additional principles — owner to confirm

### 4. Single core, thin shims

CLI, MCP, and library are adapters over one `CrontickClient` core (ADR 0001); they parse their transport's input, call one client method, and format the result. They contain zero business logic, and every capability change updates all of client, CLI, MCP, and `SURFACE_CAPABILITIES` in lockstep (enforced by `tests/unit/surface-drift.test.ts`).

- **Do** put validation, error construction, and orchestration in the core client.
- **Don't** add a CLI-only or MCP-only branch of logic that the other surfaces don't get.

### 5. Side effects behind injectable interfaces

Filesystem, network, timing (clock/timers), and process spawning are all accessed through injectable interfaces (e.g. `Runner`'s `spawnFn`, `Store`'s `dbPath`, `Logger`), never called as bare globals from business logic.

- **Do** accept a `spawnFn`/`clock`/`fs`-like dependency with a real default, so tests can substitute a fake.
- **Don't** call `child_process.spawn`, `Date.now()`, or `fs.*` directly from deep inside logic that a test would otherwise need to run for real.

### 6. No dead code, no legacy paths

Pre-1.0, a removed feature is removed, not deprecated-and-kept (ADR 0001). A capability that's gone is guarded by a regression test proving it stays gone.

- **Do** delete the old code path in the same change that removes the feature.
- **Don't** leave a flag, branch, or config option "just in case" once its feature is gone — reintroducing a removed feature requires explicit sign-off explaining why the original removal rationale no longer applies.

### 7. Actionable errors

Every error surfaced to a consumer is a typed `CrontickError` with a machine-readable `code` and a message that tells the user what to do, not just what went wrong.

- **Do** give a new failure mode its own error code and a message that names the fix (e.g. "run `crontick doctor`").
- **Don't** surface a raw `Error`, a stack trace, or a message that only restates the failure with no next step.

### 8. Platform APIs over dependencies

Prefer `node:*` built-ins (`node:fs`, `node:sqlite`, `node:crypto`, `node:util.parseArgs`, etc.) over third-party packages. A new runtime dependency needs explicit justification and review — crontick currently ships with 6 (see `docs/architecture.md#dependency-policy`).

- **Do** check for a built-in before reaching for a package.
- **Don't** add a runtime dependency to save a few lines of code that a platform API already covers.

### 9. Lightweight by construction

Ties to Tenet 6 in `mission.md`: the daemon and CLI should stay cheap to run by design, not by later optimization — no polling loop where an event or timer will do, no dependency pulled in "for convenience," no background work the product doesn't need.

- **Do** default to event-driven mechanisms (timers, `EventEmitter`) over polling.
- **Don't** add a loop that wakes up "just to check" when a scheduled callback would do.

## 10. Documentation word budgets and topic ownership

Each doc area has a word budget and exactly one narrative owner per topic; other docs link to
the owner instead of repeating it (see `docs/README.md` for the area table).

- `docs/concepts/*.md`: ≤800 words each.
- `docs/implementation/*.md`: ≤900 words each.
- `docs/reference/*.md`: uncapped (exact lookups belong here, however long).
- `docs/specs/NNN-*.md`: ≤600 words of prose (Summary/Motivation/Behavior/Edge cases/etc.); the
  Requirements and Acceptance-criteria lists don't count toward that limit.
- `docs/architecture.md`: ≤2000 words -- a components-and-links map, not a restatement of
  `docs/implementation/`, `docs/concepts/`, or `docs/reference/`.

**Do** open every doc in `concepts/`, `implementation/`, `specs/`, and `architecture.md` with a
one-line audience statement (e.g. "Audience: maintainers changing the scheduler.") and a
non-duplication note naming the doc that owns any topic it would otherwise repeat.

**Do** move a lookup-style table (full route list, exhaustive error codes, full field list) to
the relevant `docs/reference/` file rather than keeping two copies in sync by hand.

**Don't** restate another layer's narrative to pad a doc back up to a round number, and don't
let a doc grow past its budget without moving detail to its owning layer first.

## Changing these principles

Edit this file directly, and add an ADR in `docs/decisions/` when the change reflects a lasting design decision (not just a wording fix).
