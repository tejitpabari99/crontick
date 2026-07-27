# Surface Parity

After reading this page you will understand the single-core/thin-shim design principle, how crontick enforces it, and what is required when adding a new capability.

## The single-core principle

crontick exposes the same functionality through three surfaces:

1. **CLI** (`crontick` binary) - for humans in a terminal
2. **MCP server** (`crontick-mcp` binary) - for LLM agents via stdio
3. **Library API** (`import { createClient } from 'crontick'`) - for programmatic use in Node.js

All three are thin adapters over `CrontickClient`, which communicates with the daemon via its loopback HTTP API. No surface contains business logic, scheduling, persistence, or validation. Those responsibilities live exclusively in the daemon and shared core modules.

## The `SURFACE_CAPABILITIES` constant

`src/surface.ts` exports a single constant that canonically enumerates every operation the system supports:

```typescript
export const SURFACE_CAPABILITIES = [
  { capability: 'create-job', clientMethod: 'createJob', cliCommand: ['new'], mcpTool: 'crontick_job_create' },
  // ... 35 more entries
] as const satisfies readonly SurfaceCapability[];
```

Each entry maps:

| Field | Meaning |
|-------|---------|
| `capability` | Human-readable operation name |
| `clientMethod` | Method on `CrontickClient` |
| `cliCommand` | CLI subcommand path |
| `mcpTool` | MCP tool name |

## The surface-drift test

`tests/surface-drift.test.ts` uses the `SURFACE_CAPABILITIES` array to verify at test time that:

1. Every capability's `clientMethod` exists as a function on `CrontickClient.prototype`.
2. Every client prototype method is either in the capabilities table or in a known non-parity set (internal helpers like `ensure`, `health`, `request`).
3. Every MCP tool registered by the server matches a capability entry.
4. Every CLI command registered by Commander matches a capability entry.

If any surface adds or removes an operation without updating the others, the test fails.

## What "adding a capability" requires

To add a new operation (e.g., `pause-job`):

1. **Daemon API** - add the HTTP route in `src/daemon/api.ts`.
2. **Store or domain logic** - implement the behavior in the appropriate daemon module.
3. **CrontickClient** - add the public method (e.g., `pauseJob(id: string)`).
4. **SURFACE_CAPABILITIES** - add the entry linking all three surfaces.
5. **CLI** - register the Commander subcommand in `src/cli/index.ts`.
6. **MCP** - register the tool in `src/mcp/index.ts`.
7. **Library exports** - if the method or type is public API, export from `src/index.ts`.

Skipping any of these steps will cause the surface-drift test to fail.

## Why shims must contain no business logic

- **Consistency** - users and agents see identical behavior regardless of surface.
- **Testability** - core logic is tested once; shim tests only verify translation.
- **Auditability** - the capability table is the single place to review the system's API surface.
- **Maintainability** - changes to scheduling, validation, or persistence happen in one place.

If a shim needs to transform input (e.g., CLI flag parsing into a job input object), that transformation must call shared functions from `src/job-input.ts` or `src/config.ts`, never inline the logic.

## Non-parity methods

Some `CrontickClient` methods are intentionally excluded from the parity table because they are internal plumbing:

- `ensure` - daemon startup coordination
- `health` - raw health check
- `createJobFromCliOptions` - CLI-specific convenience wrapper
- `jobJsonSchema` - schema retrieval (exposed as an MCP resource, not a tool)
- `drainNotices`, `isVerbose` - internal state accessors

These are tracked in the test's `NON_PARITY_CLIENT_METHODS` set.

## Further reading

- [Architecture](../architecture.md) - component diagram and module map
- [Error model](./error-model.md) - how errors translate across surfaces
- [Testing](../testing.md) - the surface-drift test in detail
