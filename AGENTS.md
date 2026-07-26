# AGENTS.md

## Repository purpose

crontick is a standalone local cron daemon, CLI, and MCP server for scheduling jobs on a single machine, shipped as one npm package. The public API boundary is defined exclusively by the exports in `src/index.ts`; everything else is internal.

## Documentation map

Read the relevant docs before modifying the corresponding area:

| Area | Read first |
|------|-----------|
| High-level design | `docs/architecture.md` |
| Concepts (jobs, scheduling, execution, parity) | `docs/concepts/` |
| Internal module design | `docs/internals/` |
| CLI / MCP / Library reference | `docs/reference/` |
| Feature specifications | `specs/` |
| Design decisions and rationale | `docs/decisions/` |
| Testing strategy and layers | `docs/testing.md` |
| Full documentation index | `docs/README.md` |

## Required commands

```sh
npm ci                       # Install dependencies (clean)
npm run validate             # Full check: lint + typecheck + typecheck:examples + test + build + typecheck:examples:dist
npm run lint                 # ESLint
npm run typecheck            # TypeScript type-check (src)
npm run typecheck:examples   # TypeScript type-check (examples, against source types)
npm run typecheck:examples:dist  # TypeScript type-check (examples, against built dist/index.d.ts -- requires `npm run build` first, or run `npm run validate` which builds for you)
npm test                     # Vitest run (requires prior build for integration tests)
npm run build                # tsup build + sqlite fix
npm run verify-package-install  # CI-only, not part of validate: packs+installs a real tarball, exercises every public export and all three bins
```

## Source organization

- `src/client.ts` -- `CrontickClient`: all business logic lives here or in modules it calls.
- `src/cli/` -- CLI shim (thin adapter over client). No business logic.
- `src/mcp/` -- MCP server shim (thin adapter over client). No business logic.
- `src/daemon/` -- Daemon process (HTTP server, scheduler, executors).
- `src/surface.ts` -- `SURFACE_CAPABILITIES` constant: canonical list of all operations.
- `src/index.ts` -- Public API boundary. Only symbols exported here are public.
- `tests/` -- All tests live at root `tests/` (not co-located).

Do not import from `src/daemon/`, `src/cli/`, or `src/mcp/` internals outside their own shim. Cross-boundary imports must go through `src/index.ts` or the specific shared module's own exports.

## Implementation rules

1. No new runtime dependencies without explicit approval in the PR description.
2. No deep imports across module boundaries; consume via each module's public barrel.
3. No new public symbol without corresponding documentation (`docs/reference/`) and tests.
4. Preserve backward compatibility unless a spec (`specs/`) explicitly identifies a breaking change.
5. Prefer Node.js platform APIs (`node:fs`, `node:sqlite`, `node:crypto`, etc.) over third-party packages.
6. Keep filesystem, network, and timing side effects behind injectable interfaces.
7. Shims contain zero business logic -- all behavior lives in the core client and daemon modules.

## Surface parity rule

Every capability change must update ALL of:

1. The core client method (`src/client.ts`)
2. The CLI command (`src/cli/`)
3. The MCP tool (`src/mcp/`)
4. The `SURFACE_CAPABILITIES` constant (`src/surface.ts`)

If any surface is missing, `tests/surface-drift.test.ts` will fail. See `docs/concepts/surface-parity.md` for the full protocol.

## Testing rules

- Every bug fix adds a regression test.
- Test observable behavior, not private implementation details.
- No order dependence between tests.
- Use fake timers for timing-sensitive tests.
- Examples must type-check in CI (`npm run typecheck:examples`).
- See `docs/testing.md` for test layers, running instructions, and the full procedure.

## Documentation rules

When public behavior changes:

1. Update `README.md` or the relevant guide in `docs/`.
2. Update the affected file in `docs/reference/`.
3. Update the corresponding `specs/` file if one exists.
4. Add a changeset entry (`npx changeset`).
5. Add an ADR in `docs/decisions/` when the change is a lasting design decision.

## Packaging rules

1. Run `npm run validate` (must pass).
2. Run `npm pack --dry-run` and confirm only intended files are included per the `files` allowlist in `package.json`: `dist`, `plugin/**`, `src/skill/SKILL.md`, `README.md`, `LICENSE`.
3. Run `npm pack` to produce the tarball.
4. Install the tarball in a scratch directory (`npm install ./crontick-*.tgz`).
5. Exercise every documented public import (`import { createClient } from 'crontick'`) and each bin. `crontick --help` works (Commander-parsed); `crontick-daemon` and `crontick-mcp` do **not** parse `--help` or any other argv flag at all -- they always start as long-running servers, so the only exercisable check for those two bins is that the process launches and stays up (confirmed by `scripts/verify-package-install.mjs`, which starts each under a timeout and then stops it).
6. `npm run verify-package-install` (CI-only, not part of `npm run validate`) automates steps 2-5 end-to-end with a real packed tarball; confirm the `verify-package` CI job passes before release.

## Definition of done

- [ ] Implementation complete and covers the full requirement.
- [ ] `npm test` passes.
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] `npm run build` succeeds.
- [ ] Packaged output verified (tarball imports and bins work).
- [ ] Public documentation current (reference, specs, README as needed).
- [ ] Breaking-change implications evaluated and documented.
- [ ] Changeset added (`npx changeset`).
