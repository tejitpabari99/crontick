# 005: Surface Parity

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-07-25

## Summary

Every user-facing capability in crontick MUST be available on all three surfaces: CLI,
MCP server, and library API (CrontickClient). A canonical table (`SURFACE_CAPABILITIES`
in `src/surface.ts`) encodes this mapping and an automated drift test enforces it.

## Motivation

Surface parity prevents feature fragmentation. Users and agents MUST be able to
accomplish any task regardless of their chosen interface. The drift test catches
regressions early -- if a new capability is added to one surface without the others,
CI fails.

## Terminology

| Term | Definition |
|------|-----------|
| Surface | One of the three user-facing interfaces: CLI, MCP, or library API. |
| Capability | A named operation mapped across all surfaces. |
| Drift | A state where a capability exists on one surface but not another. |
| Non-parity method | A CrontickClient method intentionally excluded from parity (internal helpers). |

## Requirements

### Functional requirements

- **R-005-1**: `SURFACE_CAPABILITIES` MUST be defined in `src/surface.ts` as a readonly array of `SurfaceCapability` objects.
- **R-005-2**: Each `SurfaceCapability` MUST have: `capability` (kebab-case name), `clientMethod` (CrontickClient method name), `cliCommand` (array of CLI command segments), `mcpTool` (MCP tool name).
- **R-005-3**: For every entry in `SURFACE_CAPABILITIES`, `CrontickClient.prototype` MUST have a matching method with name equal to `clientMethod`.
- **R-005-4**: For every entry in `SURFACE_CAPABILITIES`, the built CLI MUST register a command matching `cliCommand` (verified via `--help` exit code 0).
- **R-005-5**: For every entry in `SURFACE_CAPABILITIES`, the MCP server MUST register a tool with name equal to `mcpTool`.
- **R-005-6**: Every public method on `CrontickClient.prototype` (excluding those in the non-parity set) MUST have a corresponding entry in `SURFACE_CAPABILITIES`.
- **R-005-7**: Every MCP tool prefixed `crontick_` MUST have a corresponding entry in `SURFACE_CAPABILITIES`.
- **R-005-8**: Every MCP tool MUST accept an optional `verbose: boolean` parameter.
- **R-005-9**: The non-parity exclusion set MUST be explicitly declared in the drift test (currently: `ensure`, `health`, `createJobFromCliOptions`, `jobJsonSchema`, `getConfig`, `drainNotices`, `isVerbose`, `request`, `baseUrl`, `normalizeOptions`, `shouldStartDaemon`, `effectiveEnv`, `fetchRequest`, `daemonRequestError`).
- **R-005-10**: When adding a new capability, the developer MUST add it to `SURFACE_CAPABILITIES` and implement it on all three surfaces in the same change.

### Non-functional requirements

- **R-005-11**: The drift test SHOULD run against the built artifacts (not source) to catch build-time regressions.
- **R-005-12**: The drift test SHOULD complete in under 30 seconds.

## Behavior

The drift test (`tests/surface-drift.test.ts`) performs four checks:

1. **Client method existence**: Iterates `SURFACE_CAPABILITIES` and asserts each
   `clientMethod` is a function on `CrontickClient.prototype`.
2. **Client completeness**: Gets all prototype methods, filters out non-parity and
   constructors, asserts each is in `SURFACE_CAPABILITIES` or the exclusion set.
3. **CLI command existence**: For each unique `cliCommand`, spawns
   `node dist/cli/index.js <command> --help` and asserts exit code 0.
4. **MCP tool existence**: Connects an MCP SDK client to the MCP server, lists tools,
   and asserts every `mcpTool` is registered and has a `verbose` input property.

## Inputs and outputs

**Input**: The `SURFACE_CAPABILITIES` constant, the built CLI binary, and the MCP server binary.
**Output**: Pass/fail assertions. On failure, the message names the missing capability and surface.

## Edge cases and failure modes

- New client method added without surface entry: Test 2 fails naming the method.
- New MCP tool added without surface entry: Test 4 reports unexpected tool.
- CLI command fails to register (typo in command name): Test 3 fails with non-zero exit.
- MCP server fails to start (build broken): Test 4 times out or errors on connect.
- Non-parity method accidentally included in table: No harm (test still passes), but clutters table.

## Acceptance criteria

- [x] Client exposes every table capability method (test file: `tests/surface-drift.test.ts`)
- [x] Surface table accounts for every client prototype method (test file: `tests/surface-drift.test.ts`)
- [x] CLI exposes every table capability command (test file: `tests/surface-drift.test.ts`)
- [x] MCP exposes every table capability tool (test file: `tests/surface-drift.test.ts`)
- [x] All MCP tools have verbose parameter (test file: `tests/surface-drift.test.ts`)
- [ ] Documentation updated when capability count changes

## Out of scope

- Behavioral equivalence testing (that each surface produces the same result for the same input).
- Performance parity across surfaces.
- MCP resource parity (only tools are in scope).

## Open questions

None.

## Related

- [001-job-definition.md](001-job-definition.md)
- `../docs/reference/`
- `../docs/architecture.md`
