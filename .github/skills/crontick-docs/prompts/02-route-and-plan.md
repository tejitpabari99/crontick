# Step 2: Route changes to affected docs and produce an update plan

## Objective

Map classified changes to the specific documentation files that need updating.
Produce an ordered plan grouped by disjoint doc area.

## Change-to-doc routing table

Apply this table to every classified change from Step 1:

| Change in code | Docs that MUST be updated |
|---|---|
| New/changed/removed CLI command or flag | `docs/reference/cli.md`, `examples/cli/README.md`, `README.md` if headline capability |
| New/changed/removed MCP tool or its schema | `docs/reference/mcp-tools.md`, `examples/mcp/README.md` |
| Change to `src/index.ts` exports | `docs/reference/library-api.md`, `README.md` API section, `docs/architecture.md` Public API boundary |
| New capability (any user-facing operation) | `src/surface.ts` + all three shims + `docs/reference/*` + capability count wherever stated + relevant spec |
| Zod schema change | `docs/reference/job-schema.md` or `docs/reference/configuration.md` + relevant spec |
| New error code | `docs/reference/errors.md`, `docs/concepts/error-model.md` if model changed |
| Daemon/scheduler/runner/store behavior | matching `docs/internals/*.md` + matching `docs/concepts/*.md` + matching `specs/*.md` |
| Config or env var change | `docs/reference/configuration.md` |
| Build, packaging, or CI change | `docs/internals/build-and-package.md`, `docs/testing.md`, `AGENTS.md` if a command changed |
| New test or coverage change | acceptance-criteria checkboxes in relevant `specs/*.md`, `docs/testing.md` |
| A lasting design choice | NEW ADR in `docs/decisions/` + supersede old one if reversing |
| Dependency added or removed | `docs/architecture.md` Dependency policy + ADR if architectural |

## Routing procedure

1. For each row in the Step 1 classification, look up all matching rows in the routing
   table above.

2. For each affected doc file, note:
   - Which section within the file needs updating
   - Whether it is an addition, modification, or deletion
   - What source file(s) to verify against

3. Check whether `docs/README.md` index needs updating (new files added or removed).

4. Check whether `AGENTS.md` needs updating (only if commands, source organization, or
   implementation rules changed -- never duplicate content from docs).

## Assign to disjoint groups

Group the planned updates:

| Group | Scope |
|-------|-------|
| A: Architecture + Concepts | `docs/architecture.md`, `docs/concepts/*.md` |
| B: Reference | `docs/reference/*.md` |
| C: Internals | `docs/internals/*.md` |
| D: Specs + Decisions | `specs/*.md`, `docs/decisions/*.md` |
| E: Root-level + Testing | `README.md`, `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/README.md`, `docs/testing.md`, `docs/troubleshooting.md` |
| F: Examples | `examples/**` |

## Output format

```markdown
## Update plan

### Group A: Architecture + Concepts
- [ ] `docs/architecture.md` section "Public API boundary": add `newExport()` (verify against src/index.ts:45)
- [ ] `docs/concepts/scheduling.md`: update interval behavior description (verify against src/daemon/scheduler.ts:112)

### Group B: Reference
- [ ] `docs/reference/cli.md`: add `crontick stats` command (verify against src/cli/index.ts:200)
- [ ] `docs/reference/mcp-tools.md`: add `crontick_stats_summary` tool (verify against src/mcp/index.ts:180)

### Group C: Internals
(none)

### Group D: Specs + Decisions
- [ ] `specs/005-surface-parity.md`: add acceptance criterion for stats (verify against tests/cli.test.ts)

### Group E: Root-level + Testing
- [ ] `README.md`: update capability count from 36 to 37

### Group F: Examples
(none)

### Verification sources
| Doc update | Must verify against |
|---|---|
| cli.md stats entry | src/cli/index.ts:200-215 |
| ... | ... |
```

Pass this plan to Step 3.
