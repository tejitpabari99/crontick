# 0001: Adopt single-core / thin-shim architecture

- Status: Accepted
- Date: 2026-07-25

## Context

crontick exposes the same set of operations through three surfaces: a CLI (`crontick`),
an MCP server (`crontick-mcp`), and a programmatic library (`createClient`). Early
development duplicated logic across surfaces, causing divergence in validation, error
handling, and feature availability. Adding a new operation required changes in three
files with no mechanical guarantee they stayed in sync.

## Decision

All business logic lives in a single core module (`CrontickClient` in `src/client.ts`).
The CLI, MCP server, and package export are thin adapters ("shims") that:

1. Parse their transport-specific input (Commander args, MCP JSON-RPC, TypeScript calls).
2. Delegate to one `CrontickClient` method.
3. Format the response for their transport.

Parity is enforced mechanically by:

- A `SURFACE_CAPABILITIES` constant (`src/surface.ts`) that maps every capability to its
  client method, CLI command, and MCP tool name.
- A `surface-drift.test.ts` test that verifies the client prototype, the built CLI
  `--help` output, and the live MCP tool listing all match the table.

The architectural rules are codified in `.github/skills/review-crontick/SKILL.md` and
enforced during code review by the `review-crontick` skill.

## Alternatives considered

**Shared utility functions (no client class).** Each surface imports helpers. Tested
early; led to inconsistent orchestration (daemon ensure, error wrapping) per surface.

**Code generation from a surface spec.** Feasible for tool registration boilerplate, but
crontick's surface is small enough that a parity constant plus a test provides the same
guarantee with less tooling.

**Monorepo with per-surface packages.** Would add workspace overhead (build ordering,
version coupling) without clear benefit for a single-product CLI tool.

## Consequences

**Easier:**

- Adding a new operation requires one client method, then mechanical additions to the
  CLI handler, MCP tool, and `SURFACE_CAPABILITIES` -- the drift test catches omissions.
- Bug fixes in validation or error construction propagate to all surfaces automatically.
- The surface-drift test doubles as a living inventory of the entire public API.

**Harder:**

- Surface-specific affordances (e.g., streaming output unique to CLI) must still be
  justified and allowlisted in `NON_PARITY_CLIENT_METHODS`.
- Refactoring the client class is high-impact since all surfaces depend on it.

**Impossible:**

- Shipping a surface-only feature without core support (by design).

## Revisit when

- The number of capabilities exceeds ~80-100 and the monolithic client class becomes
  unwieldy -- at that point, consider domain-grouped sub-clients.
- A surface needs fundamentally different execution semantics (e.g., a long-running
  streaming protocol) that cannot be expressed as request/response.
