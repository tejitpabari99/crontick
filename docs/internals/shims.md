# Shims

Implements: `src/cli/index.ts`, `src/mcp/index.ts`, `src/index.ts`, `src/surface.ts`

The three consumer surfaces (CLI, MCP server, library) are thin adapters over
`CrontickClient`. This document describes how they are wired, the parity
mechanism, and the process for adding a new capability.

---

## Entry Files

| Surface | Entry | Binary | Transport |
|---------|-------|--------|-----------|
| CLI | `src/cli/index.ts` | `crontick` | Commander v12 program |
| MCP | `src/mcp/index.ts` | `crontick-mcp` | `@modelcontextprotocol/sdk` StdioServerTransport |
| Library | `src/index.ts` | (none) | Direct import |

All three create a `CrontickClient` with appropriate options and delegate
operations to it. No scheduling, persistence, or validation logic lives in any
shim.

---

## CLI Wiring (`src/cli/index.ts`)

- Framework: `commander` v12.
- Global options: `--version`, `--json`, `-v/--verbose`.
- Each subcommand:
  1. Calls `client(startDaemon)` to get a `CrontickClient`.
  2. Calls the appropriate client method.
  3. Renders output via `print(data, json)` (tabular for humans, JSON for `--json`).
  4. On error: `handleError()` prints message to stderr and calls `process.exit(1)`.

Helper functions:
- `client(startDaemon = true)`: factory returning `createClient({...})`.
- `useJson()`, `useVerbose()`: read program-level options.
- `renderLogEvent(event)`: formats `LogEvent` to stderr for verbose mode.

---

## MCP Wiring (`src/mcp/index.ts`)

- SDK: `@modelcontextprotocol/sdk` v1.17.
- Server name: `"crontick"`, version: `VERSION`.
- Transport: `StdioServerTransport` (JSON-RPC 2.0 over stdin/stdout).
- 36 tools registered via `server.registerTool(name, { description, inputSchema }, handler)`.
- Each handler calls `toolWrap(args, fn, startDaemon?)`:
  1. Creates `mcpClient(startDaemon, { verbose, diagnostics })`.
  2. Calls `fn(client)`.
  3. Returns `okResult(data)` or `errResult(err)`.
- Error redaction: `redactForLlm(msg)` strips loopback addresses and file paths.
- Verbose mode: when `args.verbose === true`, response includes `{ result, diagnostics }`.
- `CRONTICK_MCP_START_DAEMON=0` disables demand-start (for testing or explicit control).
- One MCP resource: `crontick-schema-job` at URI `crontick://schemas/job`.

---

## Library Wiring (`src/index.ts`)

Re-exports `CrontickClient`, `createClient`, all schemas, types, config
helpers, logger utilities, and `SURFACE_CAPABILITIES`. See
[core-client.md](core-client.md) for the client API.

---

## SURFACE_CAPABILITIES (`src/surface.ts`)

A single constant array defining the canonical mapping between capabilities and
their expressions across all three surfaces:

```ts
interface SurfaceCapability {
  capability: string;      // e.g. 'create-job'
  clientMethod: string;    // e.g. 'createJob'
  cliCommand: string[];    // e.g. ['new']
  mcpTool: string;         // e.g. 'crontick_job_create'
}

export const SURFACE_CAPABILITIES: readonly SurfaceCapability[];
```

Currently 36 entries. Derived exports:
- `CLIENT_METHODS`: all client method names.
- `MCP_TOOLS`: all MCP tool names.

---

## Drift Test (`tests/surface-drift.test.ts`)

Enforces parity at build/test time:

1. **Client covers table**: every `SURFACE_CAPABILITIES[].clientMethod` must
   exist as a function on `CrontickClient.prototype`.
2. **Table covers client**: every client prototype method must appear in
   `SURFACE_CAPABILITIES` or in the explicit `NON_PARITY_CLIENT_METHODS` set
   (internal/helper methods like `ensure`, `health`, `isVerbose`, etc.).
3. **CLI covers table**: spawns the built CLI with `--help` for each command
   path and asserts it exists.
4. **MCP covers table**: connects an MCP SDK `Client` via `StdioClientTransport`
   to the built MCP binary, lists tools, and asserts every `mcpTool` is
   registered.

---

## Adding a New Capability (Checklist)

1. **Core logic**: implement in the appropriate module under `src/` (never in a
   shim). Expose via a new method on `CrontickClient`.
2. **SURFACE_CAPABILITIES**: add an entry to the array in `src/surface.ts` with
   the new `capability`, `clientMethod`, `cliCommand`, and `mcpTool` names.
3. **CLI**: add a Commander subcommand in `src/cli/index.ts` that calls the
   client method.
4. **MCP**: add `server.registerTool(...)` in `src/mcp/index.ts` with the
   matching tool name and input schema.
5. **Library**: if the method needs explicit re-export or new types, update
   `src/index.ts`.
6. **Drift test**: run `npm test` -- the surface-drift test will fail if any
   surface is missing the new capability.
7. **Docs**: update `docs/reference/` or `docs/` as appropriate (owned by other
   agents in this docs-overhaul).

If the new capability is internal/helper (not user-facing across all surfaces),
add its method name to `NON_PARITY_CLIENT_METHODS` in the drift test instead of
adding a `SURFACE_CAPABILITIES` entry.
