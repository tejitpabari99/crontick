# 005: Surface Parity

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-08-02

Audience: contributors adding or changing a user-facing capability. Non-duplication: this spec
is the normative contract; for the design rationale see
[concepts/surface-parity.md](../concepts/surface-parity.md).

## Summary

Every user-facing capability in crontick MUST be available on all three parity surfaces: CLI, MCP server, and library API (`CrontickClient`). A canonical table (`SURFACE_CAPABILITIES` in `src/surface.ts`) encodes this mapping and an automated drift test enforces it. The current table contains 30 capabilities.

When a change extends an existing capability rather than adding a new one (for example the `create-job` capability's `force` option), the same table MAY annotate the parity-coupled option names.

## Motivation

Surface parity prevents feature fragmentation. Users and agents MUST be able to accomplish any parity-scoped task regardless of their chosen interface. The drift test catches regressions early: if a new parity capability is added to one surface without the others, CI fails.

The command-tree reorganization intentionally narrowed some exposure without removing library/core behavior. Raw schedule validation/preview, dashboard status/data, and direct config mutation/engine helpers remain library-only and are excluded from parity. The dashboard itself is always served by the daemon on its loopback origin; the `dashboard` command group and MCP tools were removed and `crontick info` surfaces the `dashboardUrl` instead.

## Terminology

| Term | Definition |
|------|------------|
| Surface | One of the three parity interfaces: CLI, MCP, or library API. |
| Capability | A named operation mapped across all parity surfaces. |
| Drift | A state where a parity capability exists on one surface but not another. |
| Non-parity method | A `CrontickClient` method intentionally excluded from parity. |

## Requirements

### Functional requirements

- **R-005-1**: `SURFACE_CAPABILITIES` MUST be defined in `src/surface.ts` as a readonly array of `SurfaceCapability` objects.
- **R-005-2**: Each `SurfaceCapability` MUST have: `capability` (kebab-case name), `clientMethod` (`CrontickClient` method name), `cliCommand` (array of CLI command segments), and `mcpTool` (MCP tool name) unless it carries an `mcpExemption` (see R-005-13). It MAY additionally document parity-coupled option names with `optionNames`.
- **R-005-3**: For every entry in `SURFACE_CAPABILITIES`, `CrontickClient.prototype` MUST have a matching method with name equal to `clientMethod`.
- **R-005-4**: For every entry in `SURFACE_CAPABILITIES`, the built CLI MUST register a command matching `cliCommand` (verified via `--help` exit code 0).
- **R-005-5**: For every entry in `SURFACE_CAPABILITIES`, the MCP server MUST register a tool with name equal to `mcpTool`.
- **R-005-6**: Every public method on `CrontickClient.prototype` (excluding those in the non-parity set) MUST have a corresponding entry in `SURFACE_CAPABILITIES`.
- **R-005-7**: Every MCP tool prefixed `crontick_` MUST have a corresponding entry in `SURFACE_CAPABILITIES`.
- **R-005-8**: Every MCP tool MUST accept an optional `verbose: boolean` parameter.
- **R-005-9**: The non-parity exclusion set MUST be explicitly declared in the drift test.
- **R-005-10**: When adding a new parity capability, the developer MUST add it to `SURFACE_CAPABILITIES` and implement it on all three surfaces in the same change. When extending an existing capability with a user-visible option, the developer MUST update the CLI flag(s), library options, MCP schema/input, and any documented `optionNames` on that existing capability row in the same change.
- **R-005-10a**: Parameter-name normalizations MUST keep shared behavior explicit in docs and tests. Reference docs, schemas, and regression tests MUST use the current parameter name consistently on every surface.
- **R-005-13**: A capability MAY omit `mcpTool` only by declaring a non-empty `mcpExemption` string that states why it is deliberately not exposed over MCP. The drift test MUST accept exactly that exception and still fail on any other missing surface. Today the only exemptions are `autostart-enable` and `autostart-disable` (an agent must not create login persistence); `autostart-status` is exposed as `crontick_autostart_status`. The client, CLI and `SURFACE_CAPABILITIES` requirements (R-005-3, R-005-4, R-005-6) still apply to them.
- **R-005-10b**: Capabilities MAY share a CLI command path when the CLI expresses distinct operations as options on one command. `enable-job` and `disable-job` are the canonical example: both use `crontick jobs update` with `--enable` or `--disable`.

### Non-functional requirements

- **R-005-11**: The drift test SHOULD run against the built artifacts (not source) to catch build-time regressions.
- **R-005-12**: The drift test SHOULD complete in under 30 seconds.

## Current capability table

| Capability | Client method | CLI command | MCP tool |
|------------|---------------|-------------|----------|
| `create-job` | `createJob` | `crontick jobs new` | `crontick_job_create` |
| `list-jobs` | `listJobs` | `crontick jobs list` | `crontick_job_list` |
| `get-job` | `getJob` | `crontick jobs get` | `crontick_job_get` |
| `update-job` | `updateJob` | `crontick jobs update` | `crontick_job_update` |
| `enable-job` | `enableJob` | `crontick jobs update --enable` | `crontick_job_enable` |
| `disable-job` | `disableJob` | `crontick jobs update --disable` | `crontick_job_disable` |
| `delete-job` | `deleteJob` | `crontick jobs delete` | `crontick_job_delete` |
| `run-now` | `runNow` | `crontick jobs run-now` | `crontick_job_run_now` |
| `job-schedule` | `jobSchedule` | `crontick jobs schedule` | `crontick_job_schedule` |
| `cancel-run` | `cancelRun` | `crontick runs cancel` | `crontick_job_cancel_run` |
| `list-runs` | `listRuns` | `crontick runs list` | `crontick_run_list` |
| `get-run` | `getRun` | `crontick runs get` | `crontick_run_get` |
| `delete-runs` | `deleteRuns` | `crontick runs delete` | `crontick_run_delete` |
| `stats-summary` | `statsSummary` | `crontick stats summary` | `crontick_stats_summary` |
| `stats-job` | `statsJob` | `crontick stats job` | `crontick_stats_job` |
| `export` | `exportJobs` | `crontick share export` | `crontick_export` |
| `import` | `importJobs` | `crontick share import` | `crontick_import` |
| `daemon-stop` | `daemonStop` | `crontick daemon stop` | `crontick_daemon_stop` |
| `daemon-reload` | `daemonReload` | `crontick daemon reload` | `crontick_daemon_reload` |
| `daemon-pause` | `daemonPause` | `crontick daemon pause` | `crontick_daemon_pause` |
| `daemon-resume` | `daemonResume` | `crontick daemon resume` | `crontick_daemon_resume` |
| `config-list` | `configList` | `crontick config list` | `crontick_config_list` |
| `config-get` | `configGet` | `crontick config get` | `crontick_config_get` |
| `config-set` | `configSet` | `crontick config set` | `crontick_config_set` |
| `config-unset` | `configUnset` | `crontick config unset` | `crontick_config_unset` |
| `doctor` | `doctor` | `crontick doctor` | `crontick_doctor` |
| `info` | `info` | `crontick info` | `crontick_info` |
| `autostart-enable` | `autostartEnable` | `crontick autostart enable` | none (`mcpExemption`) |
| `autostart-disable` | `autostartDisable` | `crontick autostart disable` | none (`mcpExemption`) |
| `autostart-status` | `autostartStatus` | `crontick autostart status` | `crontick_autostart_status` |

Removed parity rows (including `logs` and `run-output`, folded into `get-run`; `getOutput` stays a library-only method) from the previous 37-capability surface include raw schedule validate/preview, dashboard data, dashboard start/status/stop, config get/set/unset/init/validate/engine management, `delete-run`, `config-path`, and the `daemon-start`/`daemon-status`/`daemon-restart` tools (the CLI keeps `crontick daemon start|status|restart` as CLI-only conveniences over the library-only client methods). The dashboard is always served by the daemon; `crontick info` (and `crontick_info`) surface `configPath`, daemon state, and `dashboardUrl`.

## Behavior

The drift test (`tests/unit/surface-drift.test.ts`) performs four checks:

1. **Client method existence**: Iterates `SURFACE_CAPABILITIES` and asserts each `clientMethod` is a function on `CrontickClient.prototype`.
2. **Client completeness**: Gets all prototype methods, filters out non-parity methods and constructors, and asserts each remaining method is in `SURFACE_CAPABILITIES`.
3. **CLI command existence**: For each unique `cliCommand`, spawns `node dist/cli/index.js <command> --help` and asserts exit code 0.
4. **MCP tool existence**: Connects an MCP SDK client to the MCP server, lists tools, and asserts every `mcpTool` is registered and has a `verbose` input property.

## Inputs and outputs

**Input**: The `SURFACE_CAPABILITIES` constant, the built CLI binary, and the MCP server binary.
**Output**: Pass/fail assertions. On failure, the message names the missing capability and surface.

## Edge cases and failure modes

- New client method added without surface entry: Test 2 fails naming the method.
- New parity-coupled option added on only one surface: behavioral parity drifts even though the capability count stays the same; document the option on the existing capability row and update all three surfaces together.
- Surface spellings MAY intentionally differ when a host runtime reserves a token, but the mapping MUST be documented in `SURFACE_CAPABILITIES`.
- Run-oriented MCP tools use `id` as their selector parameter. `crontick_job_cancel_run`, and `crontick_run_get` docs, schemas, and tests must stay aligned on that name.
- New MCP tool added without surface entry: Test 4 reports unexpected tool.
- CLI command fails to register (typo in command name): Test 3 fails with non-zero exit.
- MCP server fails to start (build broken): Test 4 times out or errors on connect.
- Non-parity method accidentally included in table: No harm (test still passes), but clutters the parity surface.

## Acceptance criteria

- [x] Client exposes every table capability method (test file: `tests/unit/surface-drift.test.ts`)
- [x] Surface table accounts for every client prototype method (test file: `tests/unit/surface-drift.test.ts`)
- [x] CLI exposes every table capability command (test file: `tests/unit/surface-drift.test.ts`)
- [x] MCP exposes every table capability tool (test file: `tests/unit/surface-drift.test.ts`)
- [x] All MCP tools have verbose parameter (test file: `tests/unit/surface-drift.test.ts`)
- [x] Documentation updated when capability count or parity-coupled option metadata changes (test file: `tests/unit/surface-drift.test.ts`)

## Out of scope

- Behavioral equivalence testing (that each surface produces the same result for the same input).
- Performance parity across surfaces.
- MCP resources (only tools are in scope).
- Library-only helpers intentionally excluded by the drift test.

## Open questions

None.

## Related

- [001-job-definition.md](001-job-definition.md)
- [../reference/](../reference/)
- [../architecture.md](../architecture.md)
- [../decisions/0001-architecture-and-runtime-model.md](../decisions/0001-architecture-and-runtime-model.md)
