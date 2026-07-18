# Plan: Decouple `cron-job` from Copilot → standalone NPM package + MCP server

## Goal
Extract the current `cron-job` Copilot extension into a **platform-agnostic, open-source NPM package** named `cron` (working title; final may be `@<scope>/cron` due to npm name collisions). Keep the daemon + local HTTP API + dashboard architecture. Expose the same functionality to Copilot (and any MCP-capable LLM) via a **stdio + optional HTTP MCP server**. Replace the current `/cron-job` slash-command extension with a **Copilot skill** that talks to the MCP server.

The final package supports:
- Script jobs (any shell/exec) as the primary job type — no Copilot dependency.
- LLM prompt jobs as a *plugin* (copilot / agency / arbitrary LLM CLIs) — optional.
- Cron, interval, one-shot schedules with catchup, overlap, retry, budgets, jitter.
- Cross-platform autostart (Windows HKCU Run, macOS launchd, Linux systemd --user).
- Dashboard + REST + SSE (unchanged).
- MCP server exposing every CLI/API action to LLMs.

## Multi-agent analysis dispatch

| Agent | Type | Focus |
|-------|------|-------|
| A – Codebase extraction | explore | Map current extension, identify Copilot-coupled surfaces, per-module migration notes |
| B – Ecosystem research  | research | node-cron, croner, node-schedule, bree, agenda, cronicle, PM2, systemd, launchd, Windmill, Trigger.dev, Temporal, Rundeck — features to borrow |
| C – MCP server design   | general-purpose | Tool surface, transports (stdio+http), auth, discovery, resource/prompt exposure, error model |
| D – NPM + OSS publishing | general-purpose | Package layout, ESM/types, cross-platform autostart, CI, licensing, security policy, provenance, release |
| E – Testing strategy    | general-purpose | Unit/integration/e2e/cross-platform matrix/fuzz/property/mutation/chaos/security/supply-chain/soak/perf |
| F – Junior-dev breakdown| general-purpose | Sequenced ticket list, dependencies, PR plan, migration + rollback, effort/risk |

Artifacts land in `files/` beside this plan.

## Deliverables (session `files/`)
- `01-current-state.md` (A)
- `02-ecosystem-research.md` (B)
- `03-mcp-design.md` (C)
- `04-npm-oss-plan.md` (D)
- `05-testing-plan.md` (E)
- `06-work-breakdown.md` (F)
- `00-executive-summary.md` (synthesis, produced last)

## V2 update (2026-07-18)
User decisions locked. Package renamed to **`crontick`** (single unscoped npm package + Copilot marketplace plugin of same name). Removed from scope: migration, LLM runners in core, HTTP MCP, auth, darwin/linux autostart (stubs only), deprecation of old extension. `00-executive-summary.md` fully rewritten. Files 01-06 have V2 AMENDMENT blocks prepended that override invalidated sections.
