---
status: deferred
summary: Deferred options for generating and rendering CLI/MCP reference docs from code, ranked with trade-offs.
date: 2026-09-29
---

# Futures

Deferred ideas for this initiative; not scheduled.

## Docs update and rendering

**Problem:** `docs/reference/cli.md` and `docs/reference/mcp-tools.md` are hand-written and drift from code (the 2026-09-29 audit found e.g. a nonexistent `jobs delete --all` flag, MCP example README claiming 29 tools vs 21, missing stats fields in library-api.md). No "OpenAPI for CLIs" standard has won; MCP tools are JSON-RPC + JSON Schema, not expressible as standard OpenAPI.

**Options (ranked):**

1. **Generate reference docs from code + drift test** (recommended; ~1-1.5 days; no new runtime deps, maybe `tsx` devDep).
   - Refactor `src/cli/index.ts` to export `buildProgram()` (build Commander tree without executing).
   - `scripts/gen-reference.ts`: walk Commander tree (`program.commands`, `cmd.options`, `cmd.registeredArguments`, `cmd.description()`); connect to exported `createMcpServer()` (`src/mcp/index.ts`) via the SDK's `InMemoryTransport` and call `listTools()` to get the exact `inputSchema`/`outputSchema`/annotations clients see (fallback: zod v4 `z.toJSONSchema()`); join both to `SURFACE_CAPABILITIES` (`src/surface.ts`).
   - Emit `docs/reference/cli.md`, `docs/reference/mcp-tools.md` (with "generated - do not edit" header) and `docs/reference/surface.json`. Hand-written prose/examples move to separate guide files or `.addHelpText()` / tool descriptions.
   - `npm run docs:gen` + a vitest test that regenerates in memory and asserts equality with committed files, so stale docs fail `npm run validate` (alongside `tests/unit/surface-drift.test.ts`).
   - Trade-off: static markdown, not interactive, but diffable.
2. **Interactive exploration** (~0.5 day on top of 1).
   - MCP Inspector (`npx @modelcontextprotocol/inspector node <dist mcp bin>`; also `--cli ... --method tools/list`) - the official Swagger-"try it out" equivalent for MCP; zero code, just document it.
   - Docs site: Starlight (Astro) best fit - markdown-native, search, per-command pages, `starlight-openapi` available later. Alternatives: Docusaurus (+ `docusaurus-plugin-openapi-docs`), VitePress (no first-party OpenAPI), hosted Mintlify/Fern (vendor/cost/lock-in). Dev-only, outside the npm package.
3. **Optional: `usage` spec (jdx/usage)** via `@usage-spec/commander` + `usage generate` for shell completions/manpages/Fig specs. Needs a Rust binary; Commander export is lossy - not for primary docs.
4. **Not recommended now: OpenAPI + Scalar/Redoc/Swagger UI for the daemon HTTP API** (`src/daemon/api.ts`). It's internal client-daemon transport, hand-routed with no schema source; would need a zod-to-openapi devDep, a handler refactor, and would effectively become a fourth parity surface. Revisit only if the HTTP API becomes a supported public surface.

**Avoid:** `commander-to-markdown` (unmaintained ~9 years); oclif readme generator (requires migrating to oclif); young third-party MCP doc generators (MCPSpec, mcp-doc-gen) - unverified maintenance.

**Sources:**

- https://github.com/jdx/usage
- https://usage.jdx.dev/spec/integrations
- https://github.com/modelcontextprotocol/inspector
- https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector
- https://scalar.com/alternatives/swagger-ui
- https://github.com/PaloAltoNetworks/docusaurus-openapi-docs
- https://github.com/vuejs/vitepress/issues/4133
- https://github.com/oclif/oclif/blob/main/docs/readme.md
