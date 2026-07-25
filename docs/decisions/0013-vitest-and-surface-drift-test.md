# 0013: Use vitest as the test runner with surface-drift as an architectural test

- Status: Accepted
- Date: 2026-07-18

## Context

crontick requires a test framework that:

1. Supports ESM natively (the project is ESM-only).
2. Handles TypeScript without a separate compilation step.
3. Provides fast iteration with watch mode.
4. Can run property-based tests (via `fast-check` integration).
5. Works with Node.js built-in modules including `node:sqlite`.

Additionally, the single-core architecture (ADR-0001) needs a mechanical enforcement
mechanism beyond code review -- a test that fails when a surface drifts from the declared
capability table.

## Decision

Use `vitest` (v2.1) as the test runner:

- `vitest.config.ts` configures environment `node`, includes `tests/**/*.test.ts`.
- A custom Vite plugin (`nodeSqlitePlugin`) resolves `node:sqlite` imports for the test
  environment (needed on Vite 5 which does not natively externalize it).
- `__CRONTICK_VERSION__` is defined for tests matching the build-time injection.

The **surface-drift test** (`tests/surface-drift.test.ts`) is a first-class
architectural test that:

1. Verifies every entry in `SURFACE_CAPABILITIES` has a matching method on
   `CrontickClient.prototype`.
2. Verifies every client method is accounted for in `SURFACE_CAPABILITIES` or explicitly
   allowlisted in `NON_PARITY_CLIENT_METHODS`.
3. Spawns the built CLI and checks that every table capability's command responds to
   `--help`.
4. Connects a real MCP SDK client to the built MCP server and verifies every table
   capability's tool is registered.

This test runs in CI on every PR and blocks merges that add a client method without
updating the surface table (or vice versa).

## Alternatives considered

**Jest.** The de facto standard, but ESM support is still experimental and requires
`--experimental-vm-modules`. Transform configuration for TypeScript is more complex.
Watch mode is slower than vitest's Vite-based HMR.

**`node:test` (built-in).** Zero dependencies, but lacks watch mode, snapshot testing,
and the plugin system needed for `node:sqlite` resolution. Property-based testing
integration is manual.

**Mocha + ts-node.** Requires explicit TypeScript registration, separate assertion
library (chai), and more boilerplate configuration.

**`tsx` + `node:test`.** Lighter than mocha but still lacks vitest's parallel execution,
watch mode, and Vite plugin ecosystem.

## Consequences

**Easier:**

- Zero-config TypeScript execution in tests (vitest uses Vite's transform pipeline).
- Watch mode re-runs only affected tests on file change.
- `fast-check` property tests integrate naturally as regular `it()` blocks.
- The surface-drift test catches capability mismatches mechanically -- no reviewer
  vigilance required.
- CI runs the same `npm test` locally and in GitHub Actions.

**Harder:**

- The `nodeSqlitePlugin` is a custom workaround that may break on Vite upgrades.
- Surface-drift test requires a successful build (`dist/` must exist) -- it tests the
  built artifacts, not source. This means `npm run build` must precede `npm test` in CI.
- vitest is a devDependency with a non-trivial transitive tree (Vite, esbuild, etc.).

**Impossible:**

- Running tests without Node.js >= 22.5 (due to `node:sqlite` dependency in store
  tests).

## Revisit when

- Vite natively handles `node:sqlite` externalization, eliminating the custom plugin.
- `node:test` gains watch mode and a plugin system competitive with vitest.
- The test suite grows large enough that vitest's in-process model becomes a memory
  bottleneck (unlikely for a project of this size).
