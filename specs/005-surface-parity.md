# 005: Surface Parity

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-07-28

## Summary

Every user-facing capability in crontick MUST be available on all three surfaces: CLI,
MCP server, and library API (CrontickClient). A canonical table (`SURFACE_CAPABILITIES`
in `src/surface.ts`) encodes this mapping and an automated drift test enforces it. When
a change extends an existing capability rather than adding a new one (for example the
`create-job` capability's `force` option), the same table may also annotate the
parity-coupled option names.

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
- **R-005-2**: Each `SurfaceCapability` MUST have: `capability` (kebab-case name), `clientMethod` (CrontickClient method name), `cliCommand` (array of CLI command segments), `mcpTool` (MCP tool name). It MAY additionally document parity-coupled option names (for example `optionNames: ['force']`) when an existing capability gains a new user-visible option without becoming a new capability row.
- **R-005-3**: For every entry in `SURFACE_CAPABILITIES`, `CrontickClient.prototype` MUST have a matching method with name equal to `clientMethod`.
- **R-005-4**: For every entry in `SURFACE_CAPABILITIES`, the built CLI MUST register a command matching `cliCommand` (verified via `--help` exit code 0).
- **R-005-5**: For every entry in `SURFACE_CAPABILITIES`, the MCP server MUST register a tool with name equal to `mcpTool`.
- **R-005-6**: Every public method on `CrontickClient.prototype` (excluding those in the non-parity set) MUST have a corresponding entry in `SURFACE_CAPABILITIES`.
- **R-005-7**: Every MCP tool prefixed `crontick_` MUST have a corresponding entry in `SURFACE_CAPABILITIES`.
- **R-005-8**: Every MCP tool MUST accept an optional `verbose: boolean` parameter.
- **R-005-9**: The non-parity exclusion set MUST be explicitly declared in the drift test (currently: `ensure`, `health`, `createJobFromCliOptions`, `jobJsonSchema`, `getConfig`, `drainNotices`, `isVerbose`, `request`, `baseUrl`, `normalizeOptions`, `shouldStartDaemon`, `effectiveEnv`, `fetchRequest`, `daemonRequestError`).
- **R-005-10**: When adding a new capability, the developer MUST add it to `SURFACE_CAPABILITIES` and implement it on all three surfaces in the same change. When extending an existing capability with a new user-visible option, the developer MUST update the CLI flag(s), library options, MCP schema/input, and any documented `optionNames` on that existing capability row in the same change; option growth MUST NOT invent a new capability row unless the operation itself is new.
- **R-005-10a**: Compatibility-preserving parameter normalizations MUST keep the shared behavior unchanged. When a surface prefers a new primary parameter name for consistency (for example MCP single-run tools preferring `id`), any documented deprecated alias MUST continue to map to the same capability until a future breaking removal; if both names are supplied, the preferred name wins.

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
- New parity-coupled option added on only one surface (for example CLI-only `--force` on create): behavioral parity drifts even though the capability count stays the same; document the option on the existing capability row and update all three surfaces together.
- Surface spellings MAY intentionally differ when a host runtime reserves a token. Example: the CLI's `--job-env-file` flag maps to the same persisted `action.envFile` field used by the library, MCP, and HTTP JSON surfaces because Node intercepts `--env-file` before crontick can safely parse it.
- MCP single-run tools MAY carry a deprecated alias during a soft-rename window. Example: `crontick_job_cancel_run`, `crontick_run_get`, and `crontick_run_logs_tail` prefer `id` while still accepting legacy `runId`; if both are provided, `id` wins.
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
- [x] Documentation updated when capability count or parity-coupled option metadata changes (test file: `tests/surface-drift.test.ts`)

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
