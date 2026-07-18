# 06 — Work Breakdown for `cron` Standalone NPM Package Migration

Audience: one junior developer at ~20h/week. Tickets are issue-tracker ready; P0 blocks release, P1 blocks beta quality, P2 is polish.

## ⚠️ V2 AMENDMENT (2026-07-18) — read this first.

**Package name = `crontick`.** Replace every `cron` / `@cronjs/*` mention in ticket titles/descriptions with `crontick`.

**Removed ticket categories — SKIP any ticket whose Area is one of these:**
- Migration (`Schema v4 + migration from v3 + --from-copilot-ext importer`) — no migration exists.
- LLM runner refactor / provider plugin interface / copilot/agency built-in plugins — no LLM support in core.
- HTTP MCP server / streamable-http transport tickets.
- Auth / token / bearer / token-rotate / CORS-for-MCP tickets.
- darwin autostart backend, linux autostart backend — v1 ships stubs only (single stub ticket each; no launchd/systemd unit implementation).
- Deprecation of old extension / `0.2.0-deprecated` release / `remove HKCU CopilotCronDaemon` tickets.
- Copilot-side skill install as separate ticket — folded into the marketplace plugin ticket (see below).

**Added tickets (add these to M4 / M5):**
- **T-NEW-1** (M4, M): Copilot marketplace plugin manifest + install script (`plugin/plugin.json`, `plugin/install.mjs`). Runs `npm i -g crontick` if missing; copies bundled `src/skill/SKILL.md` → `~/.copilot/skills/crontick/SKILL.md`; offers to run autostart install.
- **T-NEW-2** (M4, S): Bundle `SKILL.md` inside the npm package; verify `files` allowlist in `package.json` includes it.
- **T-NEW-3** (M5, S): Post-v1 stubs — `src/autostart/darwin.ts` + `src/autostart/linux.ts` throw `NotImplementedInV1Error` with TODO comment blocks specifying exact insertion points.
- **T-NEW-4** (M2, S): `node:sqlite` runtime detection — daemon shim adds `--experimental-sqlite` iff Node major < 24.
- **T-NEW-5** (M2, S): Localhost-only bind hardening test — reject non-loopback connections.

**Rescoped milestones (V2 — replace §1 table):**

| MS | Focus | Exit |
|---|---|---|
| M1 | Repo scaffold, TS build, CI, CLI skeleton | `crontick --version` |
| M2 | Daemon core (scheduler, runner, store, localhost HTTP API, `node:sqlite` shim) | `crontick new … && crontick list` green |
| M3 | stdio MCP server + full `crontick_*` tool catalog | Contract tests pass; verified with Copilot + Claude Desktop |
| M4 | Windows autostart + manual fallback + bundled `SKILL.md` + Copilot marketplace plugin (T-NEW-1, T-NEW-2) | Plugin install verified on Windows |
| M5 | Dashboard rebrand + ecosystem features (@daily aliases, env-file, /health) + darwin/linux stubs (T-NEW-3) | Dashboard functional; stubs compile |
| M6 | Testing hardening (unit / integration / e2e / fuzz / property / security) | All gates green |
| M7 | Docs + 0.1.0 release with provenance; submit to awesome-mcp | On npm; awesome-mcp PR opened |

Approx effort: ~65 tickets, ~6-7 weeks @ 20 h/week (was 93 tickets / 10 weeks in V1).

**§4 Migration plan for existing users — DELETE.** No migration.
**§5 Rollback plan — keep, but remove all migration-specific bullets.**

Everything else — ticket format, DAG conventions, risk register (drop rows 12 "migration data loss" and 13 "dual daemons" and 19 "old/new command confusion"), success metrics, handover artifacts — remains authoritative.

---

## 1. Milestones

- **M1 — Fork & rename** (week 1): repo scaffolded, cron --version works, tests and CI pass.
- **M2 — Decoupling & schema v4** (weeks 2-3): core is platform-agnostic, v4 schema and v3 importer work.
- **M3 — Runner + MCP MVP** (weeks 4-5): script/exec runners and stdio MCP pass contracts.
- **M4 — Cross-platform autostart** (week 6): daemon/autostart works or falls back on win32/darwin/linux.
- **M5 — HTTP MCP, dashboard, skill** (week 7): auth HTTP MCP, rebranded dashboard, rewritten skill.
- **M6 — Testing + security hardening** (week 8): unit/int/e2e/fuzz/property/security gates green.
- **M7 — Docs, release, beta** (week 9): docs, provenance, release workflow, beta complete.
- **M8 — Bake + ecosystem launch** (week 10): feedback triaged, smoke green, deprecation and ecosystem PRs done.

## 2. Ticket list

### T-001: Create standalone repository scaffold
Milestone: M1
Priority: P0
Estimate: M
Depends on: None
Files: src,tests,docs/create-standalone-repository-scaffold.ts, tests/t-001.test.ts, docs/repo-scaffolding-&-tooling.md
Description: Area: Repo scaffolding & tooling. Create standalone repository scaffold. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Repo scaffolding & tooling behavior for `Create standalone repository scaffold` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Create standalone repository scaffold`
  - integration/e2e: smallest existing harness that proves `Create standalone repository scaffold` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-002: Add CLI entrypoint and version/help commands
Milestone: M1
Priority: P0
Estimate: M
Depends on: T-001
Files: src,tests,docs/add-cli-entrypoint-and-version-help-commands.ts, tests/t-002.test.ts, docs/repo-scaffolding-&-tooling.md
Description: Area: Repo scaffolding & tooling. Add CLI entrypoint and version/help commands. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Repo scaffolding & tooling behavior for `Add CLI entrypoint and version/help commands` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add CLI entrypoint and version/help commands`
  - integration/e2e: smallest existing harness that proves `Add CLI entrypoint and version/help commands` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-003: Configure TypeScript lint format baseline
Milestone: M1
Priority: P0
Estimate: M
Depends on: T-002
Files: src,tests,docs/configure-typescript-lint-format-baseline.ts, tests/t-003.test.ts, docs/repo-scaffolding-&-tooling.md
Description: Area: Repo scaffolding & tooling. Configure TypeScript lint format baseline. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Repo scaffolding & tooling behavior for `Configure TypeScript lint format baseline` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Configure TypeScript lint format baseline`
  - integration/e2e: smallest existing harness that proves `Configure TypeScript lint format baseline` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-004: Configure Vitest isolated test harness
Milestone: M1
Priority: P0
Estimate: M
Depends on: T-003
Files: src,tests,docs/configure-vitest-isolated-test-harness.ts, tests/t-004.test.ts, docs/repo-scaffolding-&-tooling.md
Description: Area: Repo scaffolding & tooling. Configure Vitest isolated test harness. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Repo scaffolding & tooling behavior for `Configure Vitest isolated test harness` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Configure Vitest isolated test harness`
  - integration/e2e: smallest existing harness that proves `Configure Vitest isolated test harness` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-005: Add developer scripts and optional commit hooks
Milestone: M1
Priority: P1
Estimate: S
Depends on: T-004
Files: src,tests,docs/add-developer-scripts-and-optional-commit-hooks.ts, tests/t-005.test.ts, docs/repo-scaffolding-&-tooling.md
Description: Area: Repo scaffolding & tooling. Add developer scripts and optional commit hooks. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Repo scaffolding & tooling behavior for `Add developer scripts and optional commit hooks` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add developer scripts and optional commit hooks`
  - integration/e2e: smallest existing harness that proves `Add developer scripts and optional commit hooks` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-006: Establish source layout and import boundaries
Milestone: M1
Priority: P2
Estimate: M
Depends on: T-005
Files: src,tests,docs/establish-source-layout-and-import-boundaries.ts, tests/t-006.test.ts, docs/repo-scaffolding-&-tooling.md
Description: Area: Repo scaffolding & tooling. Establish source layout and import boundaries. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Repo scaffolding & tooling behavior for `Establish source layout and import boundaries` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Establish source layout and import boundaries`
  - integration/e2e: smallest existing harness that proves `Establish source layout and import boundaries` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-007: Write initial architecture decision records
Milestone: M1
Priority: P1
Estimate: M
Depends on: T-006
Files: src,tests,docs/write-initial-architecture-decision-records.ts, tests/t-007.test.ts, docs/repo-scaffolding-&-tooling.md
Description: Area: Repo scaffolding & tooling. Write initial architecture decision records. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Repo scaffolding & tooling behavior for `Write initial architecture decision records` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Write initial architecture decision records`
  - integration/e2e: smallest existing harness that proves `Write initial architecture decision records` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-008: Port and quarantine existing useful tests
Milestone: M1
Priority: P1
Estimate: M
Depends on: T-007
Files: src,tests,docs/port-and-quarantine-existing-useful-tests.ts, tests/t-008.test.ts, docs/repo-scaffolding-&-tooling.md
Description: Area: Repo scaffolding & tooling. Port and quarantine existing useful tests. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Repo scaffolding & tooling behavior for `Port and quarantine existing useful tests` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Port and quarantine existing useful tests`
  - integration/e2e: smallest existing harness that proves `Port and quarantine existing useful tests` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-009: Extract core Job model
Milestone: M2
Priority: P0
Estimate: M
Depends on: T-008 (previous area), plus relevant design artifact from Agents A-E
Files: src/core,src/cli,tests/extract-core-job-model.ts, tests/t-009.test.ts, docs/package-refactor.md
Description: Area: Package refactor. Extract core Job model. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Package refactor behavior for `Extract core Job model` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Extract core Job model`
  - integration/e2e: smallest existing harness that proves `Extract core Job model` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-010: Implement cross-platform env paths
Milestone: M2
Priority: P1
Estimate: M
Depends on: T-009
Files: src/core,src/cli,tests/implement-cross-platform-env-paths.ts, tests/t-010.test.ts, docs/package-refactor.md
Description: Area: Package refactor. Implement cross-platform env paths. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Package refactor behavior for `Implement cross-platform env paths` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement cross-platform env paths`
  - integration/e2e: smallest existing harness that proves `Implement cross-platform env paths` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-011: Create typed error taxonomy
Milestone: M2
Priority: P1
Estimate: M
Depends on: T-010
Files: src/core,src/cli,tests/create-typed-error-taxonomy.ts, tests/t-011.test.ts, docs/package-refactor.md
Description: Area: Package refactor. Create typed error taxonomy. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Package refactor behavior for `Create typed error taxonomy` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Create typed error taxonomy`
  - integration/e2e: smallest existing harness that proves `Create typed error taxonomy` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-012: Build atomic JSON job store
Milestone: M2
Priority: P0
Estimate: M
Depends on: T-011
Files: src/core,src/cli,tests/build-atomic-json-job-store.ts, tests/t-012.test.ts, docs/package-refactor.md
Description: Area: Package refactor. Build atomic JSON job store. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Package refactor behavior for `Build atomic JSON job store` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Build atomic JSON job store`
  - integration/e2e: smallest existing harness that proves `Build atomic JSON job store` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-013: Add CLI job create/list/show/delete
Milestone: M2
Priority: P0
Estimate: M
Depends on: T-012
Files: src/core,src/cli,tests/add-cli-job-create-list-show-delete.ts, tests/t-013.test.ts, docs/package-refactor.md
Description: Area: Package refactor. Add CLI job create/list/show/delete. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Package refactor behavior for `Add CLI job create/list/show/delete` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add CLI job create/list/show/delete`
  - integration/e2e: smallest existing harness that proves `Add CLI job create/list/show/delete` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-014: Implement CLI run command
Milestone: M2
Priority: P0
Estimate: M
Depends on: T-013
Files: src/core,src/cli,tests/implement-cli-run-command.ts, tests/t-014.test.ts, docs/package-refactor.md
Description: Area: Package refactor. Implement CLI run command. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Package refactor behavior for `Implement CLI run command` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement CLI run command`
  - integration/e2e: smallest existing harness that proves `Implement CLI run command` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-015: Add structured logging with redaction
Milestone: M2
Priority: P0
Estimate: M
Depends on: T-014
Files: src/core,src/cli,tests/add-structured-logging-with-redaction.ts, tests/t-015.test.ts, docs/package-refactor.md
Description: Area: Package refactor. Add structured logging with redaction. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Package refactor behavior for `Add structured logging with redaction` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add structured logging with redaction`
  - integration/e2e: smallest existing harness that proves `Add structured logging with redaction` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-016: Implement scheduler service wrapper
Milestone: M2
Priority: P0
Estimate: M
Depends on: T-015
Files: src/core,src/cli,tests/implement-scheduler-service-wrapper.ts, tests/t-016.test.ts, docs/package-refactor.md
Description: Area: Package refactor. Implement scheduler service wrapper. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Package refactor behavior for `Implement scheduler service wrapper` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement scheduler service wrapper`
  - integration/e2e: smallest existing harness that proves `Implement scheduler service wrapper` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-017: Add daemon foreground/status/stop commands
Milestone: M2
Priority: P0
Estimate: M
Depends on: T-016
Files: src/core,src/cli,tests/add-daemon-foreground-status-stop-commands.ts, tests/t-017.test.ts, docs/package-refactor.md
Description: Area: Package refactor. Add daemon foreground/status/stop commands. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Package refactor behavior for `Add daemon foreground/status/stop commands` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add daemon foreground/status/stop commands`
  - integration/e2e: smallest existing harness that proves `Add daemon foreground/status/stop commands` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-018: Enforce import boundary tests
Milestone: M2
Priority: P2
Estimate: M
Depends on: T-017
Files: src/core,src/cli,tests/enforce-import-boundary-tests.ts, tests/t-018.test.ts, docs/package-refactor.md
Description: Area: Package refactor. Enforce import boundary tests. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Package refactor behavior for `Enforce import boundary tests` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Enforce import boundary tests`
  - integration/e2e: smallest existing harness that proves `Enforce import boundary tests` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-019: Add JSON schema generation pipeline
Milestone: M2
Priority: P0
Estimate: M
Depends on: T-018 (previous area), plus relevant design artifact from Agents A-E
Files: schemas,src/core/migrate,tests,docs/add-json-schema-generation-pipeline.ts, tests/t-019.test.ts, docs/schema-v4-and-migration.md
Description: Area: Schema v4 and migration. Add JSON schema generation pipeline. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Schema v4 and migration behavior for `Add JSON schema generation pipeline` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add JSON schema generation pipeline`
  - integration/e2e: smallest existing harness that proves `Add JSON schema generation pipeline` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-020: Define schema v4 job format
Milestone: M2
Priority: P0
Estimate: M
Depends on: T-019
Files: schemas,src/core/migrate,tests,docs/define-schema-v4-job-format.ts, tests/t-020.test.ts, docs/schema-v4-and-migration.md
Description: Area: Schema v4 and migration. Define schema v4 job format. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Schema v4 and migration behavior for `Define schema v4 job format` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Define schema v4 job format`
  - integration/e2e: smallest existing harness that proves `Define schema v4 job format` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-021: Write pure v3-to-v4 migration library
Milestone: M2
Priority: P0
Estimate: M
Depends on: T-020
Files: schemas,src/core/migrate,tests,docs/write-pure-v3-to-v4-migration-library.ts, tests/t-021.test.ts, docs/schema-v4-and-migration.md
Description: Area: Schema v4 and migration. Write pure v3-to-v4 migration library. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Schema v4 and migration behavior for `Write pure v3-to-v4 migration library` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Write pure v3-to-v4 migration library`
  - integration/e2e: smallest existing harness that proves `Write pure v3-to-v4 migration library` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-022: Add migration backup manifest writer
Milestone: M2
Priority: P0
Estimate: M
Depends on: T-021
Files: schemas,src/core/migrate,tests,docs/add-migration-backup-manifest-writer.ts, tests/t-022.test.ts, docs/schema-v4-and-migration.md
Description: Area: Schema v4 and migration. Add migration backup manifest writer. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Schema v4 and migration behavior for `Add migration backup manifest writer` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add migration backup manifest writer`
  - integration/e2e: smallest existing harness that proves `Add migration backup manifest writer` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-023: Implement Copilot extension detector
Milestone: M2
Priority: P0
Estimate: M
Depends on: T-022
Files: schemas,src/core/migrate,tests,docs/implement-copilot-extension-detector.ts, tests/t-023.test.ts, docs/schema-v4-and-migration.md
Description: Area: Schema v4 and migration. Implement Copilot extension detector. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Schema v4 and migration behavior for `Implement Copilot extension detector` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement Copilot extension detector`
  - integration/e2e: smallest existing harness that proves `Implement Copilot extension detector` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-024: Implement migrate dry-run/apply CLI
Milestone: M2
Priority: P2
Estimate: L
Depends on: T-023
Files: schemas,src/core/migrate,tests,docs/implement-migrate-dry-run-apply-cli.ts, tests/t-024.test.ts, docs/schema-v4-and-migration.md
Description: Area: Schema v4 and migration. Implement migrate dry-run/apply CLI. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Schema v4 and migration behavior for `Implement migrate dry-run/apply CLI` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement migrate dry-run/apply CLI`
  - integration/e2e: smallest existing harness that proves `Implement migrate dry-run/apply CLI` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-025: Add migration conflict resolver
Milestone: M2
Priority: P0
Estimate: M
Depends on: T-024
Files: schemas,src/core/migrate,tests,docs/add-migration-conflict-resolver.ts, tests/t-025.test.ts, docs/schema-v4-and-migration.md
Description: Area: Schema v4 and migration. Add migration conflict resolver. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Schema v4 and migration behavior for `Add migration conflict resolver` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add migration conflict resolver`
  - integration/e2e: smallest existing harness that proves `Add migration conflict resolver` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-026: Create telemetry-free migration report
Milestone: M2
Priority: P0
Estimate: S
Depends on: T-025
Files: schemas,src/core/migrate,tests,docs/create-telemetry-free-migration-report.ts, tests/t-026.test.ts, docs/schema-v4-and-migration.md
Description: Area: Schema v4 and migration. Create telemetry-free migration report. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Schema v4 and migration behavior for `Create telemetry-free migration report` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Create telemetry-free migration report`
  - integration/e2e: smallest existing harness that proves `Create telemetry-free migration report` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-027: Define Runner plugin interface
Milestone: M3
Priority: P0
Estimate: M
Depends on: T-026 (previous area), plus relevant design artifact from Agents A-E
Files: src/runners,src/core,tests,docs/define-runner-plugin-interface.ts, tests/t-027.test.ts, docs/runner-refactor.md
Description: Area: Runner refactor. Define Runner plugin interface. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Runner refactor behavior for `Define Runner plugin interface` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Define Runner plugin interface`
  - integration/e2e: smallest existing harness that proves `Define Runner plugin interface` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-028: Implement script runner
Milestone: M3
Priority: P0
Estimate: M
Depends on: T-027
Files: src/runners,src/core,tests,docs/implement-script-runner.ts, tests/t-028.test.ts, docs/runner-refactor.md
Description: Area: Runner refactor. Implement script runner. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Runner refactor behavior for `Implement script runner` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement script runner`
  - integration/e2e: smallest existing harness that proves `Implement script runner` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-029: Implement exec runner
Milestone: M3
Priority: P1
Estimate: M
Depends on: T-028
Files: src/runners,src/core,tests,docs/implement-exec-runner.ts, tests/t-029.test.ts, docs/runner-refactor.md
Description: Area: Runner refactor. Implement exec runner. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Runner refactor behavior for `Implement exec runner` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement exec runner`
  - integration/e2e: smallest existing harness that proves `Implement exec runner` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-030: Add runner registry and discovery
Milestone: M3
Priority: P2
Estimate: M
Depends on: T-029
Files: src/runners,src/core,tests,docs/add-runner-registry-and-discovery.ts, tests/t-030.test.ts, docs/runner-refactor.md
Description: Area: Runner refactor. Add runner registry and discovery. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Runner refactor behavior for `Add runner registry and discovery` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add runner registry and discovery`
  - integration/e2e: smallest existing harness that proves `Add runner registry and discovery` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-031: Define LLM provider plugin interface
Milestone: M3
Priority: P1
Estimate: M
Depends on: T-030
Files: src/runners,src/core,tests,docs/define-llm-provider-plugin-interface.ts, tests/t-031.test.ts, docs/runner-refactor.md
Description: Area: Runner refactor. Define LLM provider plugin interface. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Runner refactor behavior for `Define LLM provider plugin interface` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Define LLM provider plugin interface`
  - integration/e2e: smallest existing harness that proves `Define LLM provider plugin interface` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-032: Implement optional Copilot runner plugin
Milestone: M3
Priority: P1
Estimate: M
Depends on: T-031
Files: src/runners,src/core,tests,docs/implement-optional-copilot-runner-plugin.ts, tests/t-032.test.ts, docs/runner-refactor.md
Description: Area: Runner refactor. Implement optional Copilot runner plugin. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Runner refactor behavior for `Implement optional Copilot runner plugin` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement optional Copilot runner plugin`
  - integration/e2e: smallest existing harness that proves `Implement optional Copilot runner plugin` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-033: Implement optional Agency runner plugin
Milestone: M3
Priority: P0
Estimate: M
Depends on: T-032
Files: src/runners,src/core,tests,docs/implement-optional-agency-runner-plugin.ts, tests/t-033.test.ts, docs/runner-refactor.md
Description: Area: Runner refactor. Implement optional Agency runner plugin. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Runner refactor behavior for `Implement optional Agency runner plugin` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement optional Agency runner plugin`
  - integration/e2e: smallest existing harness that proves `Implement optional Agency runner plugin` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-034: Add retry/backoff policy engine
Milestone: M3
Priority: P0
Estimate: M
Depends on: T-033
Files: src/runners,src/core,tests,docs/add-retry-backoff-policy-engine.ts, tests/t-034.test.ts, docs/runner-refactor.md
Description: Area: Runner refactor. Add retry/backoff policy engine. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Runner refactor behavior for `Add retry/backoff policy engine` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add retry/backoff policy engine`
  - integration/e2e: smallest existing harness that proves `Add retry/backoff policy engine` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-035: Create MCP stdio server entrypoint
Milestone: M3
Priority: P0
Estimate: M
Depends on: T-034 (previous area), plus relevant design artifact from Agents A-E
Files: src/mcp,tests/mcp,docs/create-mcp-stdio-server-entrypoint.ts, tests/t-035.test.ts, docs/mcp-server.md
Description: Area: MCP server. Create MCP stdio server entrypoint. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The MCP server behavior for `Create MCP stdio server entrypoint` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Create MCP stdio server entrypoint`
  - integration/e2e: smallest existing harness that proves `Create MCP stdio server entrypoint` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-036: Implement MCP job_create tool
Milestone: M3
Priority: P0
Estimate: M
Depends on: T-035
Files: src/mcp,tests/mcp,docs/implement-mcp-job_create-tool.ts, tests/t-036.test.ts, docs/mcp-server.md
Description: Area: MCP server. Implement MCP job_create tool. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The MCP server behavior for `Implement MCP job_create tool` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement MCP job_create tool`
  - integration/e2e: smallest existing harness that proves `Implement MCP job_create tool` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-037: Implement MCP job_list and job_get tools
Milestone: M3
Priority: P0
Estimate: M
Depends on: T-036
Files: src/mcp,tests/mcp,docs/implement-mcp-job_list-and-job_get-tools.ts, tests/t-037.test.ts, docs/mcp-server.md
Description: Area: MCP server. Implement MCP job_list and job_get tools. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The MCP server behavior for `Implement MCP job_list and job_get tools` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement MCP job_list and job_get tools`
  - integration/e2e: smallest existing harness that proves `Implement MCP job_list and job_get tools` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-038: Implement MCP job_update and job_delete tools
Milestone: M3
Priority: P1
Estimate: M
Depends on: T-037
Files: src/mcp,tests/mcp,docs/implement-mcp-job_update-and-job_delete-tools.ts, tests/t-038.test.ts, docs/mcp-server.md
Description: Area: MCP server. Implement MCP job_update and job_delete tools. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The MCP server behavior for `Implement MCP job_update and job_delete tools` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement MCP job_update and job_delete tools`
  - integration/e2e: smallest existing harness that proves `Implement MCP job_update and job_delete tools` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-039: Implement MCP job_run_now tool
Milestone: M3
Priority: P2
Estimate: M
Depends on: T-038
Files: src/mcp,tests/mcp,docs/implement-mcp-job_run_now-tool.ts, tests/t-039.test.ts, docs/mcp-server.md
Description: Area: MCP server. Implement MCP job_run_now tool. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The MCP server behavior for `Implement MCP job_run_now tool` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement MCP job_run_now tool`
  - integration/e2e: smallest existing harness that proves `Implement MCP job_run_now tool` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-040: Implement MCP enable/disable/pause tools
Milestone: M3
Priority: P1
Estimate: M
Depends on: T-039
Files: src/mcp,tests/mcp,docs/implement-mcp-enable-disable-pause-tools.ts, tests/t-040.test.ts, docs/mcp-server.md
Description: Area: MCP server. Implement MCP enable/disable/pause tools. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The MCP server behavior for `Implement MCP enable/disable/pause tools` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement MCP enable/disable/pause tools`
  - integration/e2e: smallest existing harness that proves `Implement MCP enable/disable/pause tools` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-041: Implement MCP history and logs tools
Milestone: M3
Priority: P1
Estimate: M
Depends on: T-040
Files: src/mcp,tests/mcp,docs/implement-mcp-history-and-logs-tools.ts, tests/t-041.test.ts, docs/mcp-server.md
Description: Area: MCP server. Implement MCP history and logs tools. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The MCP server behavior for `Implement MCP history and logs tools` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement MCP history and logs tools`
  - integration/e2e: smallest existing harness that proves `Implement MCP history and logs tools` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-042: Implement MCP jobs resource
Milestone: M3
Priority: P2
Estimate: M
Depends on: T-041
Files: src/mcp,tests/mcp,docs/implement-mcp-jobs-resource.ts, tests/t-042.test.ts, docs/mcp-server.md
Description: Area: MCP server. Implement MCP jobs resource. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The MCP server behavior for `Implement MCP jobs resource` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement MCP jobs resource`
  - integration/e2e: smallest existing harness that proves `Implement MCP jobs resource` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-043: Implement MCP schemas and capabilities resources
Milestone: M3
Priority: P0
Estimate: M
Depends on: T-042
Files: src/mcp,tests/mcp,docs/implement-mcp-schemas-and-capabilities-resources.ts, tests/t-043.test.ts, docs/mcp-server.md
Description: Area: MCP server. Implement MCP schemas and capabilities resources. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The MCP server behavior for `Implement MCP schemas and capabilities resources` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement MCP schemas and capabilities resources`
  - integration/e2e: smallest existing harness that proves `Implement MCP schemas and capabilities resources` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-044: Implement MCP workflow prompts
Milestone: M3
Priority: P0
Estimate: L
Depends on: T-043
Files: src/mcp,tests/mcp,docs/implement-mcp-workflow-prompts.ts, tests/t-044.test.ts, docs/mcp-server.md
Description: Area: MCP server. Implement MCP workflow prompts. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The MCP server behavior for `Implement MCP workflow prompts` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement MCP workflow prompts`
  - integration/e2e: smallest existing harness that proves `Implement MCP workflow prompts` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-045: Add MCP contract fixture suite
Milestone: M3
Priority: P0
Estimate: L
Depends on: T-044
Files: src/mcp,tests/mcp,docs/add-mcp-contract-fixture-suite.ts, tests/t-045.test.ts, docs/mcp-server.md
Description: Area: MCP server. Add MCP contract fixture suite. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The MCP server behavior for `Add MCP contract fixture suite` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add MCP contract fixture suite`
  - integration/e2e: smallest existing harness that proves `Add MCP contract fixture suite` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-046: Define Autostart interface and factory
Milestone: M4
Priority: P0
Estimate: M
Depends on: T-045 (previous area), plus relevant design artifact from Agents A-E
Files: src/autostart,src/cli,tests,docs/define-autostart-interface-and-factory.ts, tests/t-046.test.ts, docs/autostart.md
Description: Area: Autostart. Define Autostart interface and factory. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Autostart behavior for `Define Autostart interface and factory` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Define Autostart interface and factory`
  - integration/e2e: smallest existing harness that proves `Define Autostart interface and factory` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-047: Implement Windows HKCU autostart backend
Milestone: M4
Priority: P1
Estimate: L
Depends on: T-046
Files: src/autostart,src/cli,tests,docs/implement-windows-hkcu-autostart-backend.ts, tests/t-047.test.ts, docs/autostart.md
Description: Area: Autostart. Implement Windows HKCU autostart backend. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Autostart behavior for `Implement Windows HKCU autostart backend` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
  - Requires reviewer with Windows access to verify HKCU behavior and legacy `CopilotCronDaemon` handling.
Test:
  - unit: focused success and failure tests for `Implement Windows HKCU autostart backend`
  - integration/e2e: smallest existing harness that proves `Implement Windows HKCU autostart backend` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-048: Implement macOS launchd backend
Milestone: M4
Priority: P0
Estimate: L
Depends on: T-047
Files: src/autostart,src/cli,tests,docs/implement-macos-launchd-backend.ts, tests/t-048.test.ts, docs/autostart.md
Description: Area: Autostart. Implement macOS launchd backend. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Autostart behavior for `Implement macOS launchd backend` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
  - Requires reviewer with macOS access to verify launchd load/unload behavior.
Test:
  - unit: focused success and failure tests for `Implement macOS launchd backend`
  - integration/e2e: smallest existing harness that proves `Implement macOS launchd backend` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-049: Implement Linux systemd user backend
Milestone: M4
Priority: P0
Estimate: L
Depends on: T-048
Files: src/autostart,src/cli,tests,docs/implement-linux-systemd-user-backend.ts, tests/t-049.test.ts, docs/autostart.md
Description: Area: Autostart. Implement Linux systemd user backend. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Autostart behavior for `Implement Linux systemd user backend` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
  - Requires reviewer with Linux/systemd access and WSL/container fallback check.
Test:
  - unit: focused success and failure tests for `Implement Linux systemd user backend`
  - integration/e2e: smallest existing harness that proves `Implement Linux systemd user backend` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-050: Implement manual autostart backend
Milestone: M4
Priority: P1
Estimate: L
Depends on: T-049
Files: src/autostart,src/cli,tests,docs/implement-manual-autostart-backend.ts, tests/t-050.test.ts, docs/autostart.md
Description: Area: Autostart. Implement manual autostart backend. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Autostart behavior for `Implement manual autostart backend` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement manual autostart backend`
  - integration/e2e: smallest existing harness that proves `Implement manual autostart backend` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-051: Add autostart CLI commands
Milestone: M4
Priority: P0
Estimate: M
Depends on: T-050
Files: src/autostart,src/cli,tests,docs/add-autostart-cli-commands.ts, tests/t-051.test.ts, docs/autostart.md
Description: Area: Autostart. Add autostart CLI commands. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Autostart behavior for `Add autostart CLI commands` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add autostart CLI commands`
  - integration/e2e: smallest existing harness that proves `Add autostart CLI commands` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-052: Integrate migration daemon handoff
Milestone: M4
Priority: P0
Estimate: M
Depends on: T-051
Files: src/autostart,src/cli,tests,docs/integrate-migration-daemon-handoff.ts, tests/t-052.test.ts, docs/autostart.md
Description: Area: Autostart. Integrate migration daemon handoff. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Autostart behavior for `Integrate migration daemon handoff` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Integrate migration daemon handoff`
  - integration/e2e: smallest existing harness that proves `Integrate migration daemon handoff` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-053: Add MCP daemon/autostart status tool
Milestone: M4
Priority: P1
Estimate: M
Depends on: T-052
Files: src/autostart,src/cli,tests,docs/add-mcp-daemon-autostart-status-tool.ts, tests/t-053.test.ts, docs/autostart.md
Description: Area: Autostart. Add MCP daemon/autostart status tool. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Autostart behavior for `Add MCP daemon/autostart status tool` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add MCP daemon/autostart status tool`
  - integration/e2e: smallest existing harness that proves `Add MCP daemon/autostart status tool` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-054: Implement local token store
Milestone: M5
Priority: P2
Estimate: M
Depends on: T-053 (previous area), plus relevant design artifact from Agents A-E
Files: src/core/auth,src/mcp,tests,docs/implement-local-token-store.ts, tests/t-054.test.ts, docs/auth-token-cors-rate-limit.md
Description: Area: Auth token CORS rate limit. Implement local token store. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Auth token CORS rate limit behavior for `Implement local token store` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Implement local token store`
  - integration/e2e: smallest existing harness that proves `Implement local token store` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-055: Add HTTP MCP transport
Milestone: M5
Priority: P1
Estimate: M
Depends on: T-054
Files: src/core/auth,src/mcp,tests,docs/add-http-mcp-transport.ts, tests/t-055.test.ts, docs/auth-token-cors-rate-limit.md
Description: Area: Auth token CORS rate limit. Add HTTP MCP transport. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Auth token CORS rate limit behavior for `Add HTTP MCP transport` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add HTTP MCP transport`
  - integration/e2e: smallest existing harness that proves `Add HTTP MCP transport` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-056: Add HTTP auth middleware
Milestone: M5
Priority: P1
Estimate: M
Depends on: T-055
Files: src/core/auth,src/mcp,tests,docs/add-http-auth-middleware.ts, tests/t-056.test.ts, docs/auth-token-cors-rate-limit.md
Description: Area: Auth token CORS rate limit. Add HTTP auth middleware. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Auth token CORS rate limit behavior for `Add HTTP auth middleware` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add HTTP auth middleware`
  - integration/e2e: smallest existing harness that proves `Add HTTP auth middleware` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-057: Add CORS allowlist
Milestone: M5
Priority: P2
Estimate: S
Depends on: T-056
Files: src/core/auth,src/mcp,tests,docs/add-cors-allowlist.ts, tests/t-057.test.ts, docs/auth-token-cors-rate-limit.md
Description: Area: Auth token CORS rate limit. Add CORS allowlist. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Auth token CORS rate limit behavior for `Add CORS allowlist` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add CORS allowlist`
  - integration/e2e: smallest existing harness that proves `Add CORS allowlist` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-058: Add HTTP rate limiting
Milestone: M5
Priority: P1
Estimate: M
Depends on: T-057
Files: src/core/auth,src/mcp,tests,docs/add-http-rate-limiting.ts, tests/t-058.test.ts, docs/auth-token-cors-rate-limit.md
Description: Area: Auth token CORS rate limit. Add HTTP rate limiting. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Auth token CORS rate limit behavior for `Add HTTP rate limiting` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add HTTP rate limiting`
  - integration/e2e: smallest existing harness that proves `Add HTTP rate limiting` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-059: Rebrand dashboard shell
Milestone: M5
Priority: P0
Estimate: M
Depends on: T-058 (previous area), plus relevant design artifact from Agents A-E
Files: src/dashboard,tests,docs/rebrand-dashboard-shell.ts, tests/t-059.test.ts, docs/dashboard.md
Description: Area: Dashboard. Rebrand dashboard shell. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Dashboard behavior for `Rebrand dashboard shell` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Rebrand dashboard shell`
  - integration/e2e: smallest existing harness that proves `Rebrand dashboard shell` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-060: Add dashboard job wizard
Milestone: M5
Priority: P2
Estimate: L
Depends on: T-059
Files: src/dashboard,tests,docs/add-dashboard-job-wizard.ts, tests/t-060.test.ts, docs/dashboard.md
Description: Area: Dashboard. Add dashboard job wizard. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Dashboard behavior for `Add dashboard job wizard` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add dashboard job wizard`
  - integration/e2e: smallest existing harness that proves `Add dashboard job wizard` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-061: Add dashboard schedule preview
Milestone: M5
Priority: P0
Estimate: M
Depends on: T-060
Files: src/dashboard,tests,docs/add-dashboard-schedule-preview.ts, tests/t-061.test.ts, docs/dashboard.md
Description: Area: Dashboard. Add dashboard schedule preview. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Dashboard behavior for `Add dashboard schedule preview` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add dashboard schedule preview`
  - integration/e2e: smallest existing harness that proves `Add dashboard schedule preview` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-062: Add dashboard run history and log viewer
Milestone: M5
Priority: P0
Estimate: M
Depends on: T-061
Files: src/dashboard,tests,docs/add-dashboard-run-history-and-log-viewer.ts, tests/t-062.test.ts, docs/dashboard.md
Description: Area: Dashboard. Add dashboard run history and log viewer. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Dashboard behavior for `Add dashboard run history and log viewer` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add dashboard run history and log viewer`
  - integration/e2e: smallest existing harness that proves `Add dashboard run history and log viewer` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-063: Add dashboard migration assistant
Milestone: M5
Priority: P0
Estimate: M
Depends on: T-062
Files: src/dashboard,tests,docs/add-dashboard-migration-assistant.ts, tests/t-063.test.ts, docs/dashboard.md
Description: Area: Dashboard. Add dashboard migration assistant. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Dashboard behavior for `Add dashboard migration assistant` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add dashboard migration assistant`
  - integration/e2e: smallest existing harness that proves `Add dashboard migration assistant` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-064: Add dashboard accessibility pass
Milestone: M5
Priority: P0
Estimate: M
Depends on: T-063
Files: src/dashboard,tests,docs/add-dashboard-accessibility-pass.ts, tests/t-064.test.ts, docs/dashboard.md
Description: Area: Dashboard. Add dashboard accessibility pass. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Dashboard behavior for `Add dashboard accessibility pass` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add dashboard accessibility pass`
  - integration/e2e: smallest existing harness that proves `Add dashboard accessibility pass` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-065: Rewrite Copilot skill to call package CLI
Milestone: M5
Priority: P1
Estimate: M
Depends on: T-064 (previous area), plus relevant design artifact from Agents A-E
Files: skills/cron,docs,tests/rewrite-copilot-skill-to-call-package-cli.ts, tests/t-065.test.ts, docs/skill-rewrite.md
Description: Area: Skill rewrite. Rewrite Copilot skill to call package CLI. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Skill rewrite behavior for `Rewrite Copilot skill to call package CLI` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Rewrite Copilot skill to call package CLI`
  - integration/e2e: smallest existing harness that proves `Rewrite Copilot skill to call package CLI` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-066: Package skill with NPM distribution docs
Milestone: M5
Priority: P2
Estimate: M
Depends on: T-065
Files: skills/cron,docs,tests/package-skill-with-npm-distribution-docs.ts, tests/t-066.test.ts, docs/skill-rewrite.md
Description: Area: Skill rewrite. Package skill with NPM distribution docs. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Skill rewrite behavior for `Package skill with NPM distribution docs` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Package skill with NPM distribution docs`
  - integration/e2e: smallest existing harness that proves `Package skill with NPM distribution docs` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-067: Add skill regression examples
Milestone: M5
Priority: P1
Estimate: S
Depends on: T-066
Files: skills/cron,docs,tests/add-skill-regression-examples.ts, tests/t-067.test.ts, docs/skill-rewrite.md
Description: Area: Skill rewrite. Add skill regression examples. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Skill rewrite behavior for `Add skill regression examples` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add skill regression examples`
  - integration/e2e: smallest existing harness that proves `Add skill regression examples` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-068: Write getting started guide
Milestone: M7
Priority: P1
Estimate: M
Depends on: T-067 (previous area), plus relevant design artifact from Agents A-E
Files: docs,docs-site,README.md/write-getting-started-guide.ts, tests/t-068.test.ts, docs/docs-site.md
Description: Area: Docs site. Write getting started guide. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Docs site behavior for `Write getting started guide` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Write getting started guide`
  - integration/e2e: smallest existing harness that proves `Write getting started guide` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-069: Write migration guide
Milestone: M7
Priority: P2
Estimate: M
Depends on: T-068
Files: docs,docs-site,README.md/write-migration-guide.ts, tests/t-069.test.ts, docs/docs-site.md
Description: Area: Docs site. Write migration guide. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Docs site behavior for `Write migration guide` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Write migration guide`
  - integration/e2e: smallest existing harness that proves `Write migration guide` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-070: Write MCP integration guide
Milestone: M7
Priority: P1
Estimate: M
Depends on: T-069
Files: docs,docs-site,README.md/write-mcp-integration-guide.ts, tests/t-070.test.ts, docs/docs-site.md
Description: Area: Docs site. Write MCP integration guide. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Docs site behavior for `Write MCP integration guide` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Write MCP integration guide`
  - integration/e2e: smallest existing harness that proves `Write MCP integration guide` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-071: Write plugin authoring guide
Milestone: M7
Priority: P1
Estimate: M
Depends on: T-070
Files: docs,docs-site,README.md/write-plugin-authoring-guide.ts, tests/t-071.test.ts, docs/docs-site.md
Description: Area: Docs site. Write plugin authoring guide. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Docs site behavior for `Write plugin authoring guide` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Write plugin authoring guide`
  - integration/e2e: smallest existing harness that proves `Write plugin authoring guide` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-072: Create docs site build
Milestone: M7
Priority: P2
Estimate: M
Depends on: T-071
Files: docs,docs-site,README.md/create-docs-site-build.ts, tests/t-072.test.ts, docs/docs-site.md
Description: Area: Docs site. Create docs site build. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Docs site behavior for `Create docs site build` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Create docs site build`
  - integration/e2e: smallest existing harness that proves `Create docs site build` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-073: Add CI workflow for build and unit tests
Milestone: M7
Priority: P0
Estimate: L
Depends on: T-072 (previous area), plus relevant design artifact from Agents A-E
Files: .github/workflows,package.json,docs/add-ci-workflow-for-build-and-unit-tests.ts, tests/t-073.test.ts, docs/ci-release-provenance.md
Description: Area: CI release provenance. Add CI workflow for build and unit tests. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The CI release provenance behavior for `Add CI workflow for build and unit tests` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add CI workflow for build and unit tests`
  - integration/e2e: smallest existing harness that proves `Add CI workflow for build and unit tests` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-074: Add cross-platform CI matrix
Milestone: M7
Priority: P0
Estimate: L
Depends on: T-073
Files: .github/workflows,package.json,docs/add-cross-platform-ci-matrix.ts, tests/t-074.test.ts, docs/ci-release-provenance.md
Description: Area: CI release provenance. Add cross-platform CI matrix. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The CI release provenance behavior for `Add cross-platform CI matrix` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add cross-platform CI matrix`
  - integration/e2e: smallest existing harness that proves `Add cross-platform CI matrix` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-075: Add release workflow with provenance
Milestone: M7
Priority: P0
Estimate: L
Depends on: T-074
Files: .github/workflows,package.json,docs/add-release-workflow-with-provenance.ts, tests/t-075.test.ts, docs/ci-release-provenance.md
Description: Area: CI release provenance. Add release workflow with provenance. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The CI release provenance behavior for `Add release workflow with provenance` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add release workflow with provenance`
  - integration/e2e: smallest existing harness that proves `Add release workflow with provenance` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-076: Add dependency review and lockfile policy
Milestone: M7
Priority: P0
Estimate: M
Depends on: T-075
Files: .github/workflows,package.json,docs/add-dependency-review-and-lockfile-policy.ts, tests/t-076.test.ts, docs/ci-release-provenance.md
Description: Area: CI release provenance. Add dependency review and lockfile policy. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The CI release provenance behavior for `Add dependency review and lockfile policy` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add dependency review and lockfile policy`
  - integration/e2e: smallest existing harness that proves `Add dependency review and lockfile policy` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-077: Finalize npm metadata and name fallback
Milestone: M7
Priority: P1
Estimate: S
Depends on: T-076
Files: .github/workflows,package.json,docs/finalize-npm-metadata-and-name-fallback.ts, tests/t-077.test.ts, docs/ci-release-provenance.md
Description: Area: CI release provenance. Finalize npm metadata and name fallback. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The CI release provenance behavior for `Finalize npm metadata and name fallback` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Finalize npm metadata and name fallback`
  - integration/e2e: smallest existing harness that proves `Finalize npm metadata and name fallback` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-078: Create 0.1.0 release checklist
Milestone: M7
Priority: P2
Estimate: L
Depends on: T-077
Files: .github/workflows,package.json,docs/create-0.1.0-release-checklist.ts, tests/t-078.test.ts, docs/ci-release-provenance.md
Description: Area: CI release provenance. Create 0.1.0 release checklist. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The CI release provenance behavior for `Create 0.1.0 release checklist` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Create 0.1.0 release checklist`
  - integration/e2e: smallest existing harness that proves `Create 0.1.0 release checklist` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-079: Create shared fixture library
Milestone: M6
Priority: P1
Estimate: M
Depends on: T-078 (previous area), plus relevant design artifact from Agents A-E
Files: tests,vitest.config.ts,playwright.config.ts/create-shared-fixture-library.ts, tests/t-079.test.ts, docs/tests.md
Description: Area: Tests. Create shared fixture library. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Tests behavior for `Create shared fixture library` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Create shared fixture library`
  - integration/e2e: smallest existing harness that proves `Create shared fixture library` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-080: Add CLI integration workflow suite
Milestone: M6
Priority: P1
Estimate: L
Depends on: T-079
Files: tests,vitest.config.ts,playwright.config.ts/add-cli-integration-workflow-suite.ts, tests/t-080.test.ts, docs/tests.md
Description: Area: Tests. Add CLI integration workflow suite. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Tests behavior for `Add CLI integration workflow suite` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add CLI integration workflow suite`
  - integration/e2e: smallest existing harness that proves `Add CLI integration workflow suite` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-081: Add daemon scheduler e2e suite
Milestone: M6
Priority: P2
Estimate: L
Depends on: T-080
Files: tests,vitest.config.ts,playwright.config.ts/add-daemon-scheduler-e2e-suite.ts, tests/t-081.test.ts, docs/tests.md
Description: Area: Tests. Add daemon scheduler e2e suite. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Tests behavior for `Add daemon scheduler e2e suite` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add daemon scheduler e2e suite`
  - integration/e2e: smallest existing harness that proves `Add daemon scheduler e2e suite` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-082: Add MCP integration suite
Milestone: M6
Priority: P1
Estimate: L
Depends on: T-081
Files: tests,vitest.config.ts,playwright.config.ts/add-mcp-integration-suite.ts, tests/t-082.test.ts, docs/tests.md
Description: Area: Tests. Add MCP integration suite. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Tests behavior for `Add MCP integration suite` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add MCP integration suite`
  - integration/e2e: smallest existing harness that proves `Add MCP integration suite` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-083: Add dashboard e2e suite
Milestone: M6
Priority: P1
Estimate: L
Depends on: T-082
Files: tests,vitest.config.ts,playwright.config.ts/add-dashboard-e2e-suite.ts, tests/t-083.test.ts, docs/tests.md
Description: Area: Tests. Add dashboard e2e suite. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Tests behavior for `Add dashboard e2e suite` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add dashboard e2e suite`
  - integration/e2e: smallest existing harness that proves `Add dashboard e2e suite` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-084: Set coverage thresholds
Milestone: M6
Priority: P2
Estimate: M
Depends on: T-083
Files: tests,vitest.config.ts,playwright.config.ts/set-coverage-thresholds.ts, tests/t-084.test.ts, docs/tests.md
Description: Area: Tests. Set coverage thresholds. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Tests behavior for `Set coverage thresholds` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Set coverage thresholds`
  - integration/e2e: smallest existing harness that proves `Set coverage thresholds` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-085: Add cron expression property tests
Milestone: M6
Priority: P1
Estimate: M
Depends on: T-084 (previous area), plus relevant design artifact from Agents A-E
Files: tests/fuzz,tests/property,tests/chaos/add-cron-expression-property-tests.ts, tests/t-085.test.ts, docs/fuzz-property-mutation-chaos.md
Description: Area: Fuzz property mutation chaos. Add cron expression property tests. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Fuzz property mutation chaos behavior for `Add cron expression property tests` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add cron expression property tests`
  - integration/e2e: smallest existing harness that proves `Add cron expression property tests` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-086: Add migration fuzz tests
Milestone: M6
Priority: P1
Estimate: M
Depends on: T-085
Files: tests/fuzz,tests/property,tests/chaos/add-migration-fuzz-tests.ts, tests/t-086.test.ts, docs/fuzz-property-mutation-chaos.md
Description: Area: Fuzz property mutation chaos. Add migration fuzz tests. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Fuzz property mutation chaos behavior for `Add migration fuzz tests` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add migration fuzz tests`
  - integration/e2e: smallest existing harness that proves `Add migration fuzz tests` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-087: Add schema round-trip property tests
Milestone: M6
Priority: P2
Estimate: M
Depends on: T-086
Files: tests/fuzz,tests/property,tests/chaos/add-schema-round-trip-property-tests.ts, tests/t-087.test.ts, docs/fuzz-property-mutation-chaos.md
Description: Area: Fuzz property mutation chaos. Add schema round-trip property tests. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Fuzz property mutation chaos behavior for `Add schema round-trip property tests` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add schema round-trip property tests`
  - integration/e2e: smallest existing harness that proves `Add schema round-trip property tests` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-088: Add runner chaos tests
Milestone: M6
Priority: P1
Estimate: L
Depends on: T-087
Files: tests/fuzz,tests/property,tests/chaos/add-runner-chaos-tests.ts, tests/t-088.test.ts, docs/fuzz-property-mutation-chaos.md
Description: Area: Fuzz property mutation chaos. Add runner chaos tests. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Fuzz property mutation chaos behavior for `Add runner chaos tests` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add runner chaos tests`
  - integration/e2e: smallest existing harness that proves `Add runner chaos tests` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-089: Add storage fault injection tests
Milestone: M6
Priority: P1
Estimate: M
Depends on: T-088
Files: tests/fuzz,tests/property,tests/chaos/add-storage-fault-injection-tests.ts, tests/t-089.test.ts, docs/fuzz-property-mutation-chaos.md
Description: Area: Fuzz property mutation chaos. Add storage fault injection tests. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Fuzz property mutation chaos behavior for `Add storage fault injection tests` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add storage fault injection tests`
  - integration/e2e: smallest existing harness that proves `Add storage fault injection tests` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-090: Add mutation testing pilot
Milestone: M6
Priority: P2
Estimate: M
Depends on: T-089
Files: tests/fuzz,tests/property,tests/chaos/add-mutation-testing-pilot.ts, tests/t-090.test.ts, docs/fuzz-property-mutation-chaos.md
Description: Area: Fuzz property mutation chaos. Add mutation testing pilot. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Fuzz property mutation chaos behavior for `Add mutation testing pilot` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add mutation testing pilot`
  - integration/e2e: smallest existing harness that proves `Add mutation testing pilot` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-091: Add MCP protocol fuzz tests
Milestone: M6
Priority: P1
Estimate: M
Depends on: T-090
Files: tests/fuzz,tests/property,tests/chaos/add-mcp-protocol-fuzz-tests.ts, tests/t-091.test.ts, docs/fuzz-property-mutation-chaos.md
Description: Area: Fuzz property mutation chaos. Add MCP protocol fuzz tests. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Fuzz property mutation chaos behavior for `Add MCP protocol fuzz tests` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add MCP protocol fuzz tests`
  - integration/e2e: smallest existing harness that proves `Add MCP protocol fuzz tests` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-092: Write threat model
Milestone: M6
Priority: P1
Estimate: M
Depends on: T-091 (previous area), plus relevant design artifact from Agents A-E
Files: docs/security,tests/security/write-threat-model.ts, tests/t-092.test.ts, docs/security-threat-model.md
Description: Area: Security threat model. Write threat model. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Security threat model behavior for `Write threat model` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Write threat model`
  - integration/e2e: smallest existing harness that proves `Write threat model` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-093: Add security hardening checklist and tests
Milestone: M6
Priority: P2
Estimate: M
Depends on: T-092
Files: docs/security,tests/security/add-security-hardening-checklist-and-tests.ts, tests/t-093.test.ts, docs/security-threat-model.md
Description: Area: Security threat model. Add security hardening checklist and tests. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Security threat model behavior for `Add security hardening checklist and tests` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Add security hardening checklist and tests`
  - integration/e2e: smallest existing harness that proves `Add security hardening checklist and tests` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-094: Run dependency and license audit
Milestone: M6
Priority: P1
Estimate: M
Depends on: T-093
Files: docs/security,tests/security/run-dependency-and-license-audit.ts, tests/t-094.test.ts, docs/security-threat-model.md
Description: Area: Security threat model. Run dependency and license audit. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Security threat model behavior for `Run dependency and license audit` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Run dependency and license audit`
  - integration/e2e: smallest existing harness that proves `Run dependency and license audit` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-095: Create manual smoke test checklist
Milestone: M8
Priority: P1
Estimate: M
Depends on: T-094 (previous area), plus relevant design artifact from Agents A-E
Files: docs/smoke,tests/platform-smoke/create-manual-smoke-test-checklist.ts, tests/t-095.test.ts, docs/cross-platform-smoke-matrix.md
Description: Area: Cross-platform smoke matrix. Create manual smoke test checklist. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Cross-platform smoke matrix behavior for `Create manual smoke test checklist` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Create manual smoke test checklist`
  - integration/e2e: smallest existing harness that proves `Create manual smoke test checklist` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-096: Execute cross-platform smoke matrix
Milestone: M8
Priority: P2
Estimate: L
Depends on: T-095
Files: docs/smoke,tests/platform-smoke/execute-cross-platform-smoke-matrix.ts, tests/t-096.test.ts, docs/cross-platform-smoke-matrix.md
Description: Area: Cross-platform smoke matrix. Execute cross-platform smoke matrix. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Cross-platform smoke matrix behavior for `Execute cross-platform smoke matrix` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Execute cross-platform smoke matrix`
  - integration/e2e: smallest existing harness that proves `Execute cross-platform smoke matrix` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-097: Verify MCP host coverage
Milestone: M8
Priority: P1
Estimate: M
Depends on: T-096
Files: docs/smoke,tests/platform-smoke/verify-mcp-host-coverage.ts, tests/t-097.test.ts, docs/cross-platform-smoke-matrix.md
Description: Area: Cross-platform smoke matrix. Verify MCP host coverage. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Cross-platform smoke matrix behavior for `Verify MCP host coverage` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Verify MCP host coverage`
  - integration/e2e: smallest existing harness that proves `Verify MCP host coverage` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-098: Create beta feedback intake process
Milestone: M8
Priority: P1
Estimate: M
Depends on: T-097 (previous area), plus relevant design artifact from Agents A-E
Files: docs,.github,old-extension/create-beta-feedback-intake-process.ts, tests/t-098.test.ts, docs/beta-feedback-bake-window.md
Description: Area: Beta feedback bake window. Create beta feedback intake process. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Beta feedback bake window behavior for `Create beta feedback intake process` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Create beta feedback intake process`
  - integration/e2e: smallest existing harness that proves `Create beta feedback intake process` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-099: Run beta bake window triage
Milestone: M8
Priority: P2
Estimate: M
Depends on: T-098
Files: docs,.github,old-extension/run-beta-bake-window-triage.ts, tests/t-099.test.ts, docs/beta-feedback-bake-window.md
Description: Area: Beta feedback bake window. Run beta bake window triage. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Beta feedback bake window behavior for `Run beta bake window triage` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Run beta bake window triage`
  - integration/e2e: smallest existing harness that proves `Run beta bake window triage` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-100: Ship deprecated old extension notice
Milestone: M8
Priority: P1
Estimate: M
Depends on: T-099
Files: docs,.github,old-extension/ship-deprecated-old-extension-notice.ts, tests/t-100.test.ts, docs/beta-feedback-bake-window.md
Description: Area: Beta feedback bake window. Ship deprecated old extension notice. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Beta feedback bake window behavior for `Ship deprecated old extension notice` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Ship deprecated old extension notice`
  - integration/e2e: smallest existing harness that proves `Ship deprecated old extension notice` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

### T-101: Open ecosystem launch PRs
Milestone: M8
Priority: P1
Estimate: M
Depends on: T-100
Files: docs,.github,old-extension/open-ecosystem-launch-prs.ts, tests/t-101.test.ts, docs/beta-feedback-bake-window.md
Description: Area: Beta feedback bake window. Open ecosystem launch PRs. Implement the production path for the standalone `cron` NPM package, remove cron-job extension coupling, and keep behavior platform-agnostic unless this ticket names a platform backend.
Acceptance:
  - The Beta feedback bake window behavior for `Open ecosystem launch PRs` is implemented end-to-end and reachable from the documented CLI, MCP, dashboard, or release path.
  - The implementation is idempotent where it mutates files, daemon state, autostart, migration data, or release metadata.
  - Errors are typed, user-actionable, and redact tokens, prompts, environment secrets, and local private paths where appropriate.
  - Docs/help text explain default behavior, dry-run or rollback steps when relevant, and platform caveats.
  - A reviewer can validate the change from a clean checkout without relying on the old Copilot extension runtime.
Test:
  - unit: focused success and failure tests for `Open ecosystem launch PRs`
  - integration/e2e: smallest existing harness that proves `Open ecosystem launch PRs` works with isolated CRON_HOME
  - manual: platform or release verification when the ticket names Windows, macOS, Linux, npm, or MCP hosts

## 3. Dependency graph

Critical path adjacency list:

- T-001 -> T-002,T-003,T-004,T-006
- T-006 -> T-009,T-018,T-025,T-033,T-043
- T-009 -> T-010,T-011,T-012,T-013,T-016
- T-012 -> T-014,T-020,T-021,T-069
- T-013 -> T-014,T-023,T-055,T-079
- T-014,T-016 -> T-017 -> T-043
- T-018 -> T-019 -> T-020 -> T-021,T-022 -> T-023 -> T-049,T-080
- T-025 -> T-026,T-027 -> T-028 -> T-033
- T-029 -> T-030,T-031
- T-033 -> T-034,T-035,T-037,T-040,T-041
- T-034,T-035 -> T-036 -> T-038
- T-037,T-039,T-040,T-041 -> T-064
- T-043 -> T-044,T-045,T-046,T-047 -> T-048 -> T-049,T-050
- T-051 -> T-052 -> T-053,T-054,T-055 -> T-073
- T-056 -> T-057,T-058,T-059,T-060,T-065
- T-061,T-062,T-063,T-064,T-065,T-066 -> T-067,T-068,T-069,T-070,T-071,T-072
- T-073,T-074,T-078 -> T-085
- T-075,T-076 -> T-077 -> T-085
- T-079,T-080,T-081,T-082,T-083 -> T-085,T-086
- T-086 -> T-087 -> T-090
- T-088 -> T-090
- T-089 -> T-090 -> T-091,T-092

Critical path summary:
- Core CLI: T-001 -> T-006 -> T-009 -> T-012 -> T-013 -> T-014 -> T-017.
- Migration: T-018 -> T-019 -> T-020 -> T-021/T-022 -> T-023 -> T-049 -> T-080.
- MCP: T-025 -> T-028 -> T-033 -> T-034/T-035/T-036/T-037 -> T-064 -> T-088.
- Autostart: T-017 -> T-043 -> T-044/T-045/T-046/T-047 -> T-048 -> T-087.
- Release: T-073/T-074/T-075/T-076/T-077/T-078 plus docs T-079/T-080/T-081 -> T-085 -> T-087 -> T-090.

## 4. Migration plan for existing users

- Detect existing install by checking `~/.copilot/cron/jobs/*.json` and documented legacy variants only. Return paths, confidence, warnings, and no-op status.
- Communicate `cron migrate --from-copilot-ext --dry-run` first. Dry-run lists imports, targets, schema changes, conflicts, daemon actions, backups, and platform caveats.
- On `--apply`, copy v3 files into the new home, upgrade schema v3 to v4, and write `.bak` backups plus checksum manifest before v4 writes.
- Stop old daemon before new registration. If stop fails, report exact manual stop command and continue only with safe data import.
- Register new daemon only with explicit migration option or follow-up `cron autostart install`.
- Remove Windows HKCU `CopilotCronDaemon` by default after successful new autostart; offer `--keep-legacy-autostart`.
- On macOS/Linux remove only confidently identified old launchd/systemd artifacts; otherwise report manual cleanup.
- Ship old extension `0.2.0-deprecated` that prints pointer to package and recommends dry-run before apply.

## 5. Rollback plan

- Tag every release; hotfix from previous good tag; patch forward quickly.
- Use `npm deprecate` for bad versions; avoid unpublish unless legally/security required.
- Users pin with `npm install -g <pkg>@<previous-version>` or exact MCP host config version.
- No destructive migrations: retain v3 files and `.bak` manifests.
- **M1**: reset scaffold tag.
- **M2**: deprecate prerelease and restore from backups only on explicit user action.
- **M3**: disable bad MCP/plugin and keep script/exec CLI.
- **M4**: disable affected autostart backend and publish removal commands.
- **M5**: disable HTTP/dashboard by default and rotate tokens if needed.
- **M6**: extend beta until P0/P1 security/test blockers close.
- **M7**: deprecate bad beta and publish hotfix beta.
- **M8**: pause ecosystem PRs and publish stabilization patch.

## 6. Risk register
| # | Risk | Impact | Likelihood | Mitigation | Owner |
|---|------|--------|------------|------------|-------|
| 1 | experimental SQLite API change | storage rewrite | Medium | keep JSON primary and adapter boundary | Dev |
| 2 | croner v10 breaking | missed jobs | Medium | pin and property test | Dev |
| 3 | MCP spec churn | host breakage | High | contract fixtures and 3-host verification | Dev |
| 4 | launchd quirks macOS 15 | autostart fail | Medium | golden plist and mac reviewer | macOS reviewer |
| 5 | Windows Defender autostart flag | install distrust | Medium | HKCU only and docs | Windows reviewer |
| 6 | npm 2FA lockout | release delay | Low | trusted publishing backup maintainer | Maintainer |
| 7 | npm name collision | rename churn | High | check early fallback names | Dev |
| 8 | unmaintained deps | security burden | Medium | min deps audit | Dev |
| 9 | daemon memory leak | long-run degradation | Medium | soak chaos bounded logs | Dev |
| 10 | token leak via logs | credential exposure | High | central redaction tests | Security reviewer |
| 11 | shell injection | command execution risk | High | exec no-shell default | Dev |
| 12 | migration data loss | trust loss | Low | dry-run backups manifest | Dev |
| 13 | dual daemons | duplicate jobs | Medium | stop old remove legacy autostart | Dev |
| 14 | locked-down machines | setup failure | Medium | CRON_HOME diagnose manual fallback | Dev |
| 15 | HTTP exposed remotely | local RCE risk | Medium | localhost token CORS rate limit | Security reviewer |
| 16 | dashboard package bloat | slow installs | Medium | pack size gate | Dev |
| 17 | LLM plugin API drift | brittle plugins | Medium | minimal optional contract | Dev |
| 18 | systemd hard to test in CI | linux bug escape | High | manual smoke real machine | Linux reviewer |
| 19 | old/new command confusion | support burden | High | deprecation notice guide | Dev |
| 20 | license/provenance gap | adoption blocked | Medium | SPDX audit provenance | Maintainer |

## 7. Success metrics (post-launch)

- npm weekly downloads
- GitHub stars
- Zero P0 bugs in 30d
- Mean time to first job created < 2 min
- MCP host coverage: Copilot + 2 others verified
- Migration dry-run success > 95% on beta samples
- No token leak/destructive migration/remote HTTP exposure bugs in 30d
- Windows/macOS/Linux/WSL smoke green each 0.1.x
- 80% beta issues get first response within 2 business days

## 8. Handover artifacts
Read in order:
1. 01-current-state.md
2. 02-ecosystem-research.md
3. 03-mcp-design.md
4. 04-npm-oss-plan.md
5. 05-testing-plan.md
6. this 06-work-breakdown.md
7. old cron-job README/package manifest
8. sanitized `~/.copilot/cron/jobs/*.json` fixtures
9. MCP examples selected by Agent C
10. release/security docs from Agents D/E

Execution notes:
- Check dependencies before starting each ticket.
- Keep PRs focused and reversible.
- Ask platform reviewers early.
- Dry-run first and backups always for migration.
- Never weaken P0 acceptance silently.
