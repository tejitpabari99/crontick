# 0026: Simplify round-2 commands by folding admin reads into info

- Status: Accepted
- Date: 2026-08-03

## Context

After ADR 0024, the CLI was grouped by noun, but it still had a few top-level admin commands (`doctor`, `config`, and `daemon`) plus a dedicated `runs delete` capability. Those commands were individually understandable, but together they kept the public surface larger than necessary and spread closely related read/admin tasks across several top-level entries.

The second-round simplification goal was to keep the thin-shim/surface-parity architecture intact while making the CLI and MCP surfaces easier to scan: keep the common read surface centered on `info`, keep only the daemon operations that still make sense for CLI/MCP (`stop` and `reload`), and remove the least useful destructive capability (`delete-run`) entirely.

## Decision

Fold read/admin helpers into `info`:

- `crontick info` becomes the default environment summary and now prints the config path, daemon status, storage paths, and dashboard URL.
- `crontick doctor` moves to `crontick info doctor`.
- `crontick daemon stop` and `crontick daemon reload` move to `crontick info daemon stop` and `crontick info daemon reload`.

Remove the following parity capabilities entirely:

- `delete-run` (`runs delete`, `crontick_run_delete`, `CrontickClient.deleteRun`)
- `config-path` (`crontick config`, `crontick_config_path`)
- `daemon-start`, `daemon-status`, and `daemon-restart` from CLI/MCP parity

Keep `daemonStart`, `daemonStatus`, `daemonRestart`, and `configPath` as library-only `CrontickClient` helpers so direct library consumers still have explicit lifecycle/config hooks.

Change job bulk deletion from the old flag form to a reserved positional keyword:

- single delete: `crontick jobs delete <idOrAlias>`
- bulk delete: `crontick jobs delete all --force`

The literal CLI token `all` is reserved for bulk deletion, so a job whose alias is exactly `all` cannot be deleted from the CLI. MCP/library callers can still target `id: "all"` directly.

This shrinks `SURFACE_CAPABILITIES` from 26 to 21 rows.

## Alternatives considered

**Keep `doctor`, `config`, and `daemon` as separate top-level commands.** Rejected because they were all low-frequency inspection/admin tasks and cluttered the top-level help output.

**Keep `runs delete` for forensic cleanup symmetry.** Rejected because run retention already prunes old rows, deleting runs is less valuable than deleting jobs, and the dedicated capability added surface area across CLI, MCP, docs, and tests without supporting a core workflow.

**Remove daemon lifecycle helpers from the library as well.** Rejected because explicit lifecycle control is still useful for advanced library consumers and for tests, even though it is no longer necessary on the common CLI/MCP path.

## Consequences

**Easier / smaller:**

- Top-level help is simpler: common inspection lives under `info`.
- The parity surface is smaller (21 instead of 26 capabilities).
- MCP callers still get the same information through `crontick_info`, `crontick_doctor`, `crontick_daemon_stop`, and `crontick_daemon_reload` without a separate config-path tool.

**Trade-offs:**

- There is no direct CLI/MCP capability to delete run history manually.
- CLI users must learn that `all` is a reserved delete-all keyword.
- A daemon restart from the CLI is now expressed as `info daemon stop` followed by the next daemon-backed command (or via the library-only `daemonRestart()` helper).

## Revisit when

Revisit if users frequently need explicit daemon start/status/restart on the CLI/MCP surfaces again, or if the lack of a run-delete capability creates a real operational gap that retention and export/import do not cover.
