# 00 — Executive Summary (V2): `crontick`

> Multi-agent analysis, 2026-07-18 (V2). This supersedes V1 in every conflict. The six deep-dive artifacts (01-06) in this folder each carry a **V2 AMENDMENT** block at the top that overrides invalidated sections; the rest of their content remains authoritative.

---

## TL;DR

Build **`crontick`** — a single, standalone, open-source NPM package that ships a CLI, a daemon, and an MCP server (stdio only). No Copilot dependency in the core, no LLM runners in the core, no HTTP MCP, no auth, no migration from the current extension. Windows autostart in v1; macOS/Linux backends are stubbed for later. A Copilot **marketplace plugin also named `crontick`** installs the npm package and drops a `SKILL.md` into `~/.copilot/skills/crontick/` — that skill instructs the LLM (Copilot or any other) to *generate a shell script* and register it via MCP.

**Name**: `crontick` — verified free on npm (2026-07-18). Domains and GitHub org not verified; do that before M1.

**Scope reduction vs V1** (all confirmed by user):
- One package, not a scoped monorepo (was `@cronjs/core` family).
- **No LLM runner** in core. Only `script`/`exec` action kinds. The skill produces scripts.
- **stdio MCP only**. No HTTP transport, no bearer token, no `/api` auth surface.
- **Windows autostart only** for v1; `darwin`/`linux` backends kept as clearly-scoped empty modules for post-v1.
- **No migration**. Treat the existing extension as if it does not exist. It will be manually deleted.
- **No deprecation of the old extension**. Nothing shipped there.

---

## 1. Confirmed decisions

| # | Decision | Value |
|---|---|---|
| D-1 | Package name | **`crontick`** (single unscoped npm package; ships CLI, daemon, MCP server, dashboard, and bundled `SKILL.md`) |
| D-1a | Copilot marketplace plugin | **`crontick`** (same name) — installs the npm package globally + copies `SKILL.md` into `~/.copilot/skills/crontick/` on install |
| D-2 | Language | **TypeScript**, build with `tsup` (dual ESM+CJS+types) |
| D-3 | SQLite | **Built-in `node:sqlite`.** Node 22.5+ requires `--experimental-sqlite` flag (daemon shim injects it); Node 24+ unflagged. `engines.node >= 22.5`. No external SQLite dependency. |
| D-4 | MCP transport | **stdio only.** No HTTP MCP. |
| D-5 | Auth | **None.** No HTTP endpoints for LLMs → no token needed. Local HTTP API for the dashboard binds to `127.0.0.1` only; trust boundary = local user. Explicitly document this in README. |
| D-6 | Autostart | **`win32` (HKCU Run + VBS shim) + `manual` (prints commands) for v1.** `darwin` and `linux` module stubs pre-created under `src/autostart/` with clear TODO markers so they can be added later without restructuring. |
| D-7 | Migration | **None. Removed entirely.** Old extension is out of scope. |
| D-8 | LLM runner | **Removed from core.** Only `script` and `exec` action kinds. The bundled `SKILL.md` teaches any LLM to draft a script and register it via MCP. No copilot/agency provider adapters. |
| D-9 | License | **MIT** + DCO sign-off (no CLA) |
| D-10 | Release | **changesets** + npm publish `--provenance` via GitHub OIDC |
| D-11 | Old extension | Not touched. Not deprecated. User deletes manually. |

---

## 2. Architecture (V2)

```
Copilot / Claude Desktop / Cursor / any MCP host
         │  MCP over stdio  (spawns `crontick mcp`)
         ▼
   crontick mcp  ─────►  HTTP GET/POST to 127.0.0.1:<port>/api/*  (no auth, localhost only)
                                  │
                                  ▼
                     crontick daemon (long-lived, autostart)
                        ├─ scheduler (croner)
                        ├─ runner ──► script | exec  ← only these two kinds
                        ├─ node:sqlite runs.db
                        ├─ dashboard on 127.0.0.1:<port>
                        └─ autostart: win32 | manual  (darwin/linux stubs)

crontick CLI (`crontick new/list/run-now/…`)  ──► same 127.0.0.1 API
```

### What the LLM does (via MCP + skill)
1. User asks: *"Back up my repo every day at 9am."*
2. LLM (guided by `SKILL.md`) drafts a shell script.
3. LLM calls `crontick_schedule_validate` and `crontick_schedule_preview`.
4. LLM calls `crontick_job_create` with `action.kind = "script"`, inline script body, `cron: "0 9 * * *"`.
5. LLM confirms and reports the job id back to the user.

The core has zero knowledge of LLM providers. If the user wants their script to *invoke* an LLM CLI (e.g. `copilot -p "..."`), they put that command inside the script — the daemon just runs the script.

---

## 3. Component decisions

### 3.1 Single package layout (`crontick`)
```
crontick/
├── package.json                  # bin: { crontick, crontick-daemon, crontick-mcp }
├── src/
│   ├── cli/                      # commander-based CLI
│   ├── daemon/                   # scheduler, runner, store, api, lifecycle
│   ├── mcp/                      # stdio MCP server; talks to local daemon over localhost HTTP
│   ├── autostart/
│   │   ├── index.ts              # Autostart interface + factory
│   │   ├── win32.ts              # HKCU Run + VBS shim  (v1)
│   │   ├── manual.ts             # prints instructions   (v1)
│   │   ├── darwin.ts             # STUB — throws "not implemented in v1" with TODO markers
│   │   └── linux.ts              # STUB — same
│   ├── runners/
│   │   ├── script.ts             # inline body → tmp file → spawn
│   │   └── exec.ts               # argv array → spawn
│   ├── schemas/                  # job.schema.json (v1 — no version churn since no migration)
│   ├── skill/
│   │   └── SKILL.md              # bundled; copied to ~/.copilot/skills/crontick/ by the plugin
│   └── dashboard/                # static app
├── plugin/                       # Copilot marketplace plugin manifest + install script
│   ├── plugin.json
│   └── install.mjs               # npm i -g crontick, cp SKILL.md → ~/.copilot/skills/crontick/
├── tests/
├── docs/
└── .github/
```

### 3.2 Job schema (fresh — no v-numbers needed)
Since there is no migration, the schema is just `schema.json` (no `$schemaVersion` gymnastics). Action kinds:

```jsonc
{
  "id": "daily-backup",
  "description": "…",
  "enabled": true,
  "schedule": { "kind": "cron|interval|one-shot", … },   // unchanged from V1
  "action": {
    "kind": "script",                                     // "script" or "exec"
    "script": "#!/usr/bin/env bash\nset -euo pipefail\n…",
    "shell": "auto|bash|pwsh|cmd",
    "cwd": "…",
    "env": { … },
    "timeoutSec": 3600
  },
  "catchup": "run-once|run-all|skip",
  "overlap": "skip|queue|cancel-previous",
  "retry": { "max": 0, "backoffSec": 30 },
  "budgets": { "maxRunsPerDay": null, "maxTokensPerRun": null }
}
```

- `action.kind: "exec"` uses `{ command, args[], shell?: false }` (argv form; no shell injection risk by default).
- No `llm-prompt`, no `provider`, no `resumeSessionId`, no `attachments`.

### 3.3 MCP tool catalog (V2)
Keep from `03-mcp-design.md`, **drop these**:
- `cron_migrate_from_copilot_ext`
- All auth/token tools (`cron_token_rotate`, etc.)
- LLM-provider-specific fields inside `cron_job_create` input schema

Rename all tool ids from `cron_*` to `crontick_*` (avoid collision with other MCP scheduler servers).

Final catalog:
- **Jobs**: `crontick_job_{create, list, get, update, delete, enable, disable, run_now, cancel_run}`
- **Runs**: `crontick_run_{list, get, logs_tail}`
- **Schedules**: `crontick_schedule_{preview, validate}`
- **Stats**: `crontick_stats_{summary, job}`
- **Daemon**: `crontick_daemon_{status, reload, restart}` (no `shutdown` — dangerous with no auth boundary; require CLI for that)
- **Autostart**: `crontick_autostart_{status, install, remove}`
- **Admin**: `crontick_export`, `crontick_import`, `crontick_dashboard_open`, `crontick_doctor`

Resources: `crontick://jobs/{id}`, `crontick://runs/{id}`, `crontick://runs/{id}/log`, `crontick://schemas/job`.

Prompts: `create-scheduled-script`, `investigate-failed-run`.

### 3.4 The bundled `SKILL.md`
Ships inside the npm package at `src/skill/SKILL.md`. The Copilot marketplace plugin copies it to `~/.copilot/skills/crontick/SKILL.md` on install. Content teaches the LLM to:
1. Understand the user's intent (script, cadence, boundaries, side effects).
2. Draft a **shell script** (bash on unix, pwsh on Windows) that accomplishes the task idempotently.
3. Call `crontick_schedule_validate` + `crontick_schedule_preview` on the proposed schedule.
4. Call `crontick_job_create` with `action.kind = "script"`, inline body.
5. Cite the returned job id.
6. Confirm before delete/disable.
7. Never invent an LLM sub-runtime — the script must be self-contained (it can shell out to `copilot`/`claude` etc. inside itself; that's the user's script, not the scheduler's concern).

Full draft in `03-mcp-design.md` §5 (with V2 amendments applied — the "provider selection" content there is dropped).

### 3.5 Cross-platform paths
`env-paths`-based resolution:
- Windows: `%USERPROFILE%\AppData\Local\crontick\` (root); optional `~/.crontick/` symlink for discoverability.
- macOS (post-v1): `~/Library/Application Support/crontick/`.
- Linux (post-v1): `$XDG_STATE_HOME/crontick` or `~/.local/state/crontick/`.

Autostart backend for v1 = win32 only. `crontick autostart install` on non-win32 prints the manual instructions from `autostart/manual.ts`.

### 3.6 The Copilot marketplace plugin
- Plugin id: `crontick` (same as npm package).
- Manifest declares:
  - `install`: runs `npm i -g crontick` if not present; then `crontick init` (creates data dir, generates config).
  - `postInstall`: copies bundled `SKILL.md` to `~/.copilot/skills/crontick/SKILL.md`.
  - Optionally starts the daemon and registers autostart (with user prompt).
- `uninstall`: leaves data dir intact by default; provides `crontick uninstall --purge`.

This gives Copilot users one-click install; non-Copilot users just `npm i -g crontick`. Identical binary either way.

---

## 4. Testing (unchanged from V1 minus the removed surfaces)

All 13 test layers in `05-testing-plan.md` stay. Delete/skip:
- HTTP MCP transport tests, MCP bearer-auth tests.
- LLM provider adapter tests.
- v3→v4 migration tests.
- macOS launchd and Linux systemd tests (until we ship those backends).

Add:
- Marketplace plugin install/uninstall test on Windows.
- `SKILL.md` copy-to-target test.
- Script-only runner tests (already present; expand).

---

## 5. Delivery plan (V2 rescoped)

**~7 milestones, ~65 tickets, ~6-7 weeks @ 20 h/week** (down from ~93 tickets / 10 weeks in V1 — thanks to dropping migration, LLM adapters, HTTP MCP, auth, and 2 autostart backends).

| MS | Focus | Exit |
|---|---|---|
| M1 | Repo scaffold, TS build, CI, CLI skeleton | `crontick --version` |
| M2 | Daemon core (scheduler, runner, store, HTTP API on localhost) | `crontick new … && crontick list` green |
| M3 | stdio MCP server + full tool catalog | Contract tests pass; verified with Copilot MCP host + Claude Desktop |
| M4 | Windows autostart + manual fallback + `SKILL.md` bundled + Copilot marketplace plugin | `crontick autostart install` works on Windows; plugin install verified |
| M5 | Dashboard rebrand + polish; ecosystem features (cron aliases, env-file, `/health`) | Dashboard functional; `@daily` etc. accepted |
| M6 | Testing hardening (unit / integration / e2e / fuzz / property / security) | All gates green |
| M7 | Docs + 0.1.0 release with provenance | Published on npm, submitted to awesome-mcp |

Post-v1 backlog (single ticket each, deferred): darwin autostart, linux autostart, HTTP MCP + auth, distributed HA daemon, resource limits.

---

## 6. Risk register (V2 delta)

| # | Risk | Mitigation |
|---|---|---|
| 1 | `--experimental-sqlite` semantics change between Node 22.5 and 24 | Guard with `process.versions.node` check; test both matrices |
| 2 | `croner` v10 breaking | Pin, property-test |
| 3 | MCP spec churn | Contract fixtures; verify against Copilot + Claude Desktop + Cursor |
| 4 | Windows Defender flags autostart | HKCU only; sigstore provenance |
| 5 | Local dashboard reachable over LAN | Explicitly bind to `127.0.0.1`; test |
| 6 | Shell injection via script action | `exec` mode = argv (no shell) default; `script` mode writes to file with mode 700 |
| 7 | npm name squatted after we decide | Claim `crontick` on npm immediately (day 0) |
| 8 | Marketplace plugin can't `npm i -g` on a locked-down machine | Fallback: bundle `crontick` into the plugin as a vendored copy; document trade-off |
| 9 | User expects LLM runner and finds none | README is explicit: "Scripts only. LLMs generate scripts via the skill." |

Full 20-item register in `06-work-breakdown.md` §6.

---

## 7. What the junior dev does day 1

1. Read files in order: 00 (this), 01, 02, 03, 04, 05, 06 — **respecting the V2 AMENDMENT blocks at the top of 01-06**.
2. Claim `crontick` on npm; create GitHub repo `crontick`; create Copilot marketplace plugin listing `crontick`.
3. Open ticket T-001 (repo scaffold). Follow the DAG in `06-work-breakdown.md` §3, **skipping any ticket in the V2-removed categories** (migration, LLM adapters, HTTP MCP, auth, darwin/linux autostart, deprecation).
4. Push after every ticket; every PR passes the DoD in `05-testing-plan.md` §16.

---

## 8. Artifacts inventory (V2)

Location: `C:\Users\tejitpabari\.copilot\session-state\9e2c541e-1ef1-4f9a-bcc0-74beb0f148da\files\`

| File | Notes |
|---|---|
| `plan.md` | Dispatch log |
| `00-executive-summary.md` | **This file. V2 authoritative.** |
| `01-current-state.md` | V2 amendment prepended; migration + LLM sections marked SUPERSEDED |
| `02-ecosystem-research.md` | V2 amendment: name = `crontick`; ignore auth/HTTP recommendations |
| `03-mcp-design.md` | V2 amendment: stdio only; no auth; drop LLM/migration tools; rename `cron_*` → `crontick_*` |
| `04-npm-oss-plan.md` | V2 amendment: single unscoped package `crontick`; TS build; no HTTP; win32+manual autostart |
| `05-testing-plan.md` | V2 amendment: drop HTTP-MCP/auth/LLM/migration tests |
| `06-work-breakdown.md` | V2 amendment: drop migration + LLM + HTTP-MCP + auth + darwin/linux + deprecation tickets; rescoped to ~7 milestones |

Ready to hand off.
