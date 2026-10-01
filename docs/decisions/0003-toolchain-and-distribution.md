# 0003: Toolchain and distribution

- Status: Accepted
- Date: 2026-09-28
- Supersedes: former ADRs 0002, 0006, 0007, 0009, 0010, 0011 (the vitest/test-runner
  portion only; the surface-drift architectural test itself is covered by
  [ADR 0001](0001-architecture-and-runtime-model.md)).

## Context

Several early ADRs each recorded one tooling or dependency choice in isolation: the
module format crontick publishes, the cron-expression/scheduling library, the schema
validation library, the release/versioning tool, the build bundler, and the test runner.
Individually these are ordinary technology choices; grouped together they describe one
coherent policy crontick follows repeatedly -- prefer a single well-scoped dependency (or
a Node platform API) per concern, chosen for fit with an ESM-only, `node:sqlite`-based,
single-package CLI tool, over hand-rolling the concern or reaching for a heavier
general-purpose alternative. This ADR keeps that policy visible without a separate
document per library.

## Decision

### ESM-only distribution

crontick ships as ESM only: `package.json` declares `"type": "module"`, the build
(`tsup`, below) emits only an `esm` target, and the `exports` map has no `"require"`
condition. crontick targets Node >= 22.5 and uses top-level `await`, `node:sqlite`, and
other ESM-first APIs; the initial dual ESM+CJS output was dropped once no consumer needed
CJS, since crontick itself already depends on ESM-only packages (`env-paths`, `croner`)
and dual-format publishing risks a dual-package hazard (the same module loaded twice,
once per format, with separately-initialized state). A CJS consumer must use dynamic
`import()`.

### croner for cron parsing and scheduling

`croner` is the sole cron-expression parser and scheduling-timer library
(`src/daemon/scheduler.ts`): constructor-time validation, `Cron.nextRuns(n)` for preview,
timezone-aware scheduling, an optional seconds field, and zero transitive dependencies.
The scheduler uses croner's timer for `cron`-kind schedules and native
`setTimeout`/`setInterval` for `interval`/`one-shot` kinds. Alternatives
(`cron-parser`, which has no built-in timer; `node-cron`, weaker timezone/seconds
support; a hand-rolled parser) were all judged to add either missing functionality
crontick would have to build itself, or a real risk of subtle edge-case bugs (DST
transitions) in a concern that is not crontick's core value proposition.

### zod for validation at every surface boundary

`zod` is the single schema/validation library across `src/schemas/`: every domain type
(job, schedule, action, config) is a zod schema, `z.infer` keeps runtime validation and
compile-time types from drifting apart, discriminated unions model schedule/action
variants precisely, and `zod-to-json-schema` derives the JSON Schema sidecar files and
the `crontick://schemas/job` MCP resource from the same source of truth. Every CLI flag,
MCP param, library call, and persisted JSON file is validated at its boundary before
reaching business logic, so invalid input fails fast with a structured, actionable
message rather than a deep stack trace.

### changesets for versioning and release

`@changesets/cli` drives version bumps and `CHANGELOG.md` generation. Contributors add a
changeset file describing a change's semver impact; `release.yml` opens a "Version
Packages" PR on `main` that batches pending changesets, and merging it triggers
`npm publish` with provenance. This was chosen over commit-message-driven tools
(`release-please`, `semantic-release`) because it lets multiple breaking changes
accumulate deliberately across several PRs before one release, which matters for a
pre-1.0, single-maintainer project that wants to review a changelog before it ships
rather than publish on every merge.

### tsup for the build

`tsup` (an esbuild wrapper) bundles crontick's four entry points (CLI, daemon, MCP
server, library) into single files with ESM output, shebang injection, sourcemaps, and
`.d.ts` generation, driven by one declarative `tsup.config.ts`. A small post-build script
(`scripts/fix-node-sqlite.mjs`) rewrites bare `"sqlite"` imports to `"node:sqlite"`,
because esbuild does not natively externalize the `node:` protocol prefix; this is a
known, narrow workaround, not a sign the tool is a poor fit. `tsc`-only and raw `esbuild`
were both rejected for lacking one or more of bundling, shebang handling, and built-in
declaration generation without extra scripting.

### vitest as the test runner

`vitest` runs the test suite (`tests/**/*.test.ts`) with native ESM/TypeScript support
and a custom Vite plugin resolving `node:sqlite` for the test environment (needed because
Vite does not natively externalize it either). It was chosen over Jest (heavier ESM
setup, slower watch mode), `node:test` (no watch mode or plugin system for the
`node:sqlite` resolution needed here), and Mocha (more manual TypeScript/assertion
wiring). The architecturally significant test that happens to run under vitest --
`tests/unit/surface-drift.test.ts`, which mechanically enforces CLI/MCP/library parity -- is
covered as part of the architecture itself in
[ADR 0001](0001-architecture-and-runtime-model.md); vitest is only the vehicle that runs
it.

## Alternatives considered

Each area above already states its specific rejected alternatives (dual ESM+CJS,
`cron-parser`/`node-cron`, `ajv`+JSON-Schema-first, `standard-version`/`semantic-release`,
raw esbuild/`rollup`/`webpack`, Jest/`node:test`/Mocha). The common thread across all of
them: a heavier or lower-level alternative was available in every case, and was rejected
because it would require crontick to build functionality (a scheduling timer, JSON
Schema generation, changelog automation, declaration-file generation, or ESM/`node:sqlite`
test-environment support) that the chosen tool already provides, for a project small
enough that the extra tool's overhead is worth it.

## Consequences

**Easier:** one output format with no conditional-exports resolution bugs; adding a
schema field is one zod line that updates types, validation, and JSON Schema together;
each PR declares its own semver impact instead of relying on commit-message discipline;
the build and test configs are each a single declarative file.

**Harder:** CJS-only consumers cannot `require('crontick')` directly; crontick inherits
croner's and zod's upstream behavior and release cadence (including any breaking major
version); the `fix-node-sqlite.mjs` and vitest `node:sqlite` plugin are both workarounds
for the same underlying gap (bundlers/test runners not yet externalizing the `node:`
protocol) that would need updating if either tool changes its resolution behavior.

**Impossible:** `require('crontick')` without an async wrapper; publishing without a
changeset (by design, to prevent an accidental release).

## Revisit when

- A significant consumer demonstrates a hard CJS requirement and is willing to maintain
  dual-build CI validation.
- croner, zod, changesets, tsup, or vitest is abandoned, or a critical unpatched
  vulnerability is discovered in one of them.
- esbuild or Vite natively handle `node:` protocol externalization, removing the need for
  `fix-node-sqlite.mjs` and the custom vitest plugin.
- The project moves to a monorepo with multiple published packages, which would need
  changesets' workspace mode and tsup's multi-package config.
