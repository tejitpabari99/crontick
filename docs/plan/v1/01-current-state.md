# 01 — Current State: cron-job → crontick extraction audit

> ## ⚠️ V2 AMENDMENT (2026-07-18) — read this first, it overrides parts of the doc below.
>
> - **Package name is `crontick`** (single unscoped npm package). Ignore any V1 references to `cron`, `@cronjs/*`, `cronjs`.
> - **§4 Runner extraction** — DROP the "LLM provider adapter" plan entirely. The new runner supports only `script` and `exec`. Delete plans for `providerAdapters.copilot`, `providerAdapters.agency`, `providerAdapters.custom`.
> - **§5 Schema evolution** — do NOT preserve v3 or produce v4-vs-v3 diffs. There is **no migration**. Start with a fresh single schema (no `$schemaVersion` field needed; drop the migration column). Only `action.kind ∈ {script, exec}` — remove `llm-prompt` and every provider-specific field.
> - **§6 HTTP API surface** — DROP the "bearer auth" and `~/.cron/token` plan. The API binds to `127.0.0.1` only; local user is the trust boundary. Do NOT add auth middleware. Keep `/api/version`.
> - **§7 Autostart abstraction** — v1 ships **win32 + manual only**. Keep `darwin.ts` and `linux.ts` as stub modules with a clear "not implemented in v1" throw and TODO markers; do not wire them into the platform switch until post-v1.
> - **§10 Skill vs MCP** — the new skill teaches the LLM to *generate a shell script* and register it via MCP (no `llm-prompt` action). Bundle the `SKILL.md` inside the npm package at `src/skill/SKILL.md`; the Copilot marketplace plugin copies it to `~/.copilot/skills/crontick/SKILL.md` on install.
> - **§11 Backward compatibility / migration** — DELETE ENTIRELY. The current extension is treated as if it does not exist. No `cron migrate --from-copilot-ext`, no `.bak` handling, no import path detection.
> - **§2 Copilot coupling map** — the "move-to-plugin" rows for LLM runners are downgraded to **remove**. Only kept for historical reference of what to delete.
> - Path/env-var neutral defaults still apply but rename `~/.cron` → `~/.crontick` (or use `env-paths` per D-5 in the summary).
>
> Everything else in this document remains valid.
>
> ---

# 01 — Current State: cron-job → crontick extraction audit

> Produced by Agent A (codebase-extraction). Source: `C:\Users\tejitpabari\.copilot\extensions\cron-job` @ 2026-07-17.

## 1) Inventory

| File/module | Purpose |
|---|---|
| `/cli.mjs` | Native CLI entrypoint; parses args, confirms destructive ops, dispatches subcommands. |
| `/extension.mjs` | Copilot SDK extension bootstrap; registers `/cron-job` command and skill directory. |
| `/bin/daemon.mjs` | Main daemon process; starts DB, scheduler, HTTP API, watcher, graceful shutdown. |
| `/bin/cron-run.mjs` | Legacy runner helpers; parses run metadata, log rotation, runtime argv. |
| `/bin/cron-run.cmd` | Windows wrapper that invokes `bin/cron-run.mjs`. |
| `/lib/dispatch.mjs` | Subcommand router for all `/cron-job` actions. |
| `/lib/paths.mjs` | Central filesystem/port constants and job path helpers. |
| `/lib/runtime-config.mjs` | Writes Copilot runtime config auto-approve setting. |
| `/lib/config.mjs` | Local config file read/write (`CRON_ROOT/config.json`). |
| `/lib/cli-invocation.mjs` | Normalizes Copilot TUI vs native CLI invocation. |
| `/lib/daemon-port.mjs` | Resolves daemon port; handles collisions. |
| `/lib/ipc-client.mjs` | Client for daemon status and REST calls. |
| `/lib/selfInstall.mjs` | Copies runtime binaries, schema, skill, autostart, daemon bootstrap. |
| `/lib/security.mjs` | Windows ACL hardening and session warning logging. |
| `/lib/parseFlags.mjs` | Flag parser used by CLI/dispatch. |
| `/lib/duration.mjs` | Duration parsing helpers. |
| `/lib/format.mjs` | Output formatting helpers. |
| `/lib/exit-codes.mjs` | Exit code constants. |
| `/lib/canonical-json.mjs` | Stable JSON serialization for diffing. |
| `/lib/uninstall.mjs` | Uninstall workflow. |
| `/lib/schedule.mjs` | Schedule parsing and next-run calculation. |
| `/lib/daemon/*` | Runtime engine: store, scheduler, runner, lifecycle, API, migration, autostart, DB, process control. |
| `/lib/subcommands/*` | One file per CLI verb (`new`, `edit`, `list`, `logs`, etc.). |
| `/dashboard/*` | Static dashboard app served by daemon. |
| `/skills/cron/SKILL.md` | Copilot skill instructions. |
| `/skills/cron/README.md` | Skill README / packaging metadata. |
| `/schemas/*` | Job schema and run DB SQL bootstrap. |
| `/tests/*` | Unit/integration tests covering CLI, daemon, runner, dashboard, install, schema, security. |
| `/docs/SETUP.md` | Extension setup and install notes. |
| `/README.md` | User-facing project description. |

## 2) Copilot coupling map

| Location | Copilot touchpoint | Classify | What to do |
|---|---|---|---|
| `/extension.mjs:1-47` | `@github/copilot-sdk/extension`, `joinSession`, `/cron-job` slash command | `remove` | Delete from standalone package; replace with MCP server. |
| `/extension.mjs:18-42` | `skillDirectories`, Copilot session logging | `remove` | Not needed outside Copilot. |
| `/lib/runtime-config.mjs:6-34` | `chat.tools.global.autoApprove` in Copilot config | `remove` | Delete; unsafe and Copilot-specific. |
| `/lib/selfInstall.mjs:45-46` | auto-approve config write | `remove` | Remove from standalone installer. |
| `/lib/selfInstall.mjs:57-103` | installs `~/.copilot/skills/cron/SKILL.md` | `move-to-plugin` | Make skill install optional, or ship separate Copilot integration package. |
| `/lib/selfInstall.mjs:60-76` | HKCU autostart + daemon ensure | `move-to-plugin` | Move to platform-specific autostart plugin. |
| `/lib/selfInstall.mjs:68-69` | "Registered CopilotCronDaemon…" | `remove` | Rename/replace. |
| `/lib/daemon/autostart.mjs:7-12` | `CopilotCronDaemon`, `CopilotCronWatchdog` | `remove` | Rename to neutral identifiers. |
| `/lib/daemon/autostart.mjs:67-75` | Windows watchdog behavior tied to daemon | `move-to-plugin` | Keep as optional plugin. |
| `/cli.mjs:31-32` | references `CopilotCronDaemon` in prompt | `remove` | Rewrite neutral uninstall text. |
| `/bin/daemon.mjs:49-50, 56-69, 124-149, 196` | "copilot cron daemon" logging | `keep-as-generic` | Rename logs to `cron daemon`. |
| `/lib/daemon/runner.mjs:18-57` | `copilot`, `agency`, `--resume`, prompt semantics | `move-to-plugin` | Make LLM runner pluggable; script/exec core stays. |
| `/lib/daemon/runner.mjs:243-245` | `CRON_RUN_SESSION_ID` for script runs | `keep-as-generic` | Keep as neutral metadata env var. |
| `/lib/daemon/runner.mjs:33-56` | Copilot/agency command builders | `move-to-plugin` | Extract provider adapters. |
| `/lib/subcommands/doctor.mjs:158-165` | checks `copilot.exe` / `agency.exe` | `move-to-plugin` | Provider plugin check only. |
| `/lib/subcommands/doctor.mjs:33-36` | `.auth-required` / copilot login | `remove` | Replace with package auth checks. |
| `/skills/cron/SKILL.md` | Copilot-native skill content, slash command workflow | `remove` | Rebuild as MCP-oriented skill guide. |

## 3) Runtime paths / env / registry / ports

### Current paths

| Kind | Current path |
|---|---|
| Root | `~/.copilot/cron` (`CRON_ROOT`, `/lib/paths.mjs:6`) |
| Jobs | `~/.copilot/cron/jobs` (`/lib/paths.mjs:15`) |
| Prompts | `~/.copilot/cron/prompts` (`/lib/paths.mjs:7`) |
| Logs | `~/.copilot/cron/logs` (`/lib/paths.mjs:8`) |
| Temp | `~/.copilot/cron/tmp` (`/lib/paths.mjs:9`) |
| Binaries | `~/.copilot/cron/bin` (`/lib/paths.mjs:10`) |
| Schema cache | `~/.copilot/cron/schema` (`/lib/paths.mjs:11`) |
| Dashboard assets | `~/.copilot/cron/dashboard` (`/lib/paths.mjs:12`) |
| Install state | `~/.copilot/cron/.install-state.json` (`/lib/paths.mjs:14`) |
| Runs DB | `~/.copilot/cron/runs.db` (`/lib/paths.mjs:16`) |
| PID file | `~/.copilot/cron/.daemon.pid` (`/lib/paths.mjs:17`) |
| Port file | `~/.copilot/cron/.daemon-port.json` (`/lib/paths.mjs:18`) |
| Config | `~/.copilot/cron/config.json` (`/lib/config.mjs:7`) |
| Skill install | `~/.copilot/skills/cron/SKILL.md` (`/lib/selfInstall.mjs:83`) |
| Win autostart VBS | `~/.copilot/cron/bin/daemon-hidden.vbs` (`/lib/daemon/autostart.mjs:11-12`) |
| Dashboard log | `~/.copilot/cron/logs/daemon.log` (`/bin/daemon.mjs:31-35`) |
| Session log | `~/.copilot/cron/logs/session.log` (`/lib/security.mjs:9-12`) |

### Current env vars

| Env var | Use |
|---|---|
| `CRON_ROOT_OVERRIDE` | Test/custom root override (`/lib/paths.mjs:6`, `/bin/daemon.mjs:24`) |
| `COPILOT_CRON_PORT` | Daemon port override (`/lib/paths.mjs:26-28`, `/lib/daemon-port.mjs:32-41`) |
| `CRON_PRUNE_INTERVAL_MS` | Prune cadence (`/bin/daemon.mjs:74-86`) |
| `CRON_TEST_SKIP_RUNTIME_CONFIG` | Test skip for auto-approve (`/lib/selfInstall.mjs:45`) |
| `CRON_TEST_SKIP_INSTALL` | Skip install in extension bootstrap (`/extension.mjs:34`) |
| `CRON_TEST_SKIP_WTS` | Test helper in scripts (`/package.json:26-27`) |
| `COPILOT_CLI` | Copilot CLI invocation mode (`/lib/cli-invocation.mjs:5`) |
| `CRON_COPILOT_CONFIG_PATH` | Explicit Copilot config path (`/lib/runtime-config.mjs:29`) |

### Registry / Windows artifacts

| Kind | Current value |
|---|---|
| HKCU Run key | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (`/lib/daemon/autostart.mjs:7`) |
| Run value name | `CopilotCronDaemon` (`/lib/daemon/autostart.mjs:8`) |
| Watchdog task | `CopilotCronWatchdog` (`/lib/daemon/autostart.mjs:9`) |
| VBS shim | `daemon-hidden.vbs` in `BIN_DIR` (`/lib/daemon/autostart.mjs:11-12`) |

### Neutral defaults to adopt

- Root: `~/.cron`
- Config: `~/.config/cron/config.json` (or root-local fallback on Windows)
- Logs: `~/.local/state/cron/logs` or `~/.cron/logs`
- Jobs: `~/.cron/jobs`
- Skill install: `~/.copilot/skills/cron` only in Copilot integration package
- Autostart service name: `CronDaemon`
- Registry value: `CronDaemon`
- Port env var: `CRON_PORT`
- Root override env var: `CRON_HOME`
- API token: `~/.cron/token`

## 4) Runner extraction

### Today
`/lib/daemon/runner.mjs:16-57` chooses:
- `script` → shell execution
- `agency` → `agency cp -p ...`
- default → `copilot -p ...`

It also injects `--resume`, tools, dirs, attachments, timeout, session IDs, logs, and retry/queue/overlap logic (`/lib/daemon/runner.mjs:101-176`, `214-260`).

### Required refactor
1. Make runner core **script-first**:
   - `script` and `exec` should be first-class.
   - LLM prompts become one action type, not the core type.
2. Split command construction into adapters:
   - `providerAdapters.copilot`
   - `providerAdapters.agency`
   - `providerAdapters.custom`
3. Resolve provider only if action.kind = `llm-prompt`.
4. If `copilot`/`agency` binaries are absent:
   - `script`/`exec` still work.
   - `llm-prompt` fails with a clear provider-not-found error.
5. Move all provider-specific flags (`--resume`, tools, attachments) behind adapter contracts.

## 5) Schema evolution

### Target v4 shape
```json
{
  "$schemaVersion": 4,
  "action": {
    "kind": "script|exec|llm-prompt"
  }
}
```

### Recommended action objects
- `script`: `{ command, args, shell?, env? }`
- `exec`: `{ command, args, shell?, env? }`
- `llm-prompt`: `{ provider, cli, args, promptFlag, prompt, ...providerOpts }`

### Diff-style summary

| Field | v3 | v4 |
|---|---|---|
| `$schemaVersion` | `3` | `4` |
| `action.kind` | `copilot-prompt`, `script` | `llm-prompt`, `script`, `exec` |
| `action.runtime` | `copilot|agency|script` | remove; fold into `llm-prompt.provider` |
| `action.prompt` | top-level action prompt | keep only for `llm-prompt` |
| `action.agent` | provider-specific | move into `llm-prompt.args` or provider opts |
| `action.allowAllTools` | provider-specific | move into `llm-prompt.args` |
| `action.availableTools` | provider-specific | move into `llm-prompt.args` |
| `action.allowedDirs` | provider-specific | move into `llm-prompt.args` |
| `action.attachments` | provider-specific | move into `llm-prompt.args` |
| `action.resumeSessionId` | provider-specific | rename to `llm-prompt.sessionId` or provider opts |
| `action.sharedSession` | Copilot-specific | remove or plugin-only |
| `action.script` | inline script | keep for `script` only |
| `action.scriptPath` | script file path | keep for `script` only |
| `action.cwd` | generic | keep; applies to all kinds |
| `action.timeoutSec` | generic | keep |
| `action.kind` value `copilot-prompt` | current default | rename to `llm-prompt` |
| `action.output*` | generic | keep |
| `catchup/overlap/retry/budgets/jitter/schedule` | generic | keep |

## 6) HTTP API surface

### Current routes (`/lib/daemon/api.mjs:476-520`)
- `GET /api/health`
- `GET /api/jobs`
- `POST /api/jobs`
- `GET /api/runs`
- `GET /api/stats`
- `POST /api/reload`
- `POST /api/shutdown`
- `POST /api/open`
- `POST /api/reveal`
- `GET /api/jobs/:id`
- `PATCH /api/jobs/:id`
- `DELETE /api/jobs/:id`
- `POST /api/jobs/:id/enable`
- `POST /api/jobs/:id/disable`
- `POST /api/jobs/:id/run-now`
- `GET /api/jobs/:id/runs`
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/tail`
- `GET /api/stats/:jobId`
- `GET /*` static dashboard files

### Standalone changes
- Keep: all job/run endpoints, `/api/health`, static dashboard.
- Rename: `/api/open` → `/api/fs/open` or `/api/ui/open`.
- Remove or gate: `/api/shutdown` if auth is absent; otherwise keep with bearer auth.
- Add:
  - `GET /api/version`
  - bearer auth on all mutating routes
  - token file at `~/.cron/token`
  - CORS config for MCP/dashboard if needed
- Add request auth middleware before routing.

## 7) Autostart abstraction

### Current
Windows-only registry autostart + VBS shim + optional watchdog (`/lib/daemon/autostart.mjs`).

### Required interface
```ts
interface Autostart {
  status(): Promise<Status>;
  install(opts): Promise<Result>;
  remove(): Promise<Result>;
}
```

### Implementations
- `win32`
  - registry Run key
  - `CronDaemon`
  - optional VBS shim
- `darwin`
  - LaunchAgent plist at `~/Library/LaunchAgents/com.cron.daemon.plist`
  - `launchctl bootstrap gui/$UID ...`
- `linux`
  - systemd user unit at `~/.config/systemd/user/cron-daemon.service`
  - `systemctl --user enable --now ...`
- `manual`
  - print exact startup command and install path hints

## 8) Tests inventory

### Carry over cleanly
- `canonical-json.test.mjs`
- `cli-argv-parse.test.mjs` (after renaming)
- schedule tests
- daemon/store/scheduler/runs-db tests
- API tests for generic job/run behavior
- dashboard rendering tests
- security ACL tests (Windows-only subset)

### Rewrite
- `extension.test.mjs`
- `selfInstall-skill.test.mjs`
- `runtime-config.test.mjs`
- `selfInstall-autostart.test.mjs`
- `subcommand-*` tests that mention `/cron-job`, Copilot, agency
- `runner-session-resume.test.mjs`
- `runner-max-tokens.test.mjs`
- `runner-attachments.test.mjs`
- `runner-script.test.mjs` if command model changes

### New tests needed
- MCP auth/token tests
- `llm-prompt`, `script`, `exec` schema tests
- cross-platform autostart tests
- migration from `~/.copilot/cron`
- provider-adapter absence tests
- API version endpoint tests

## 9) Dashboard

Change:
- Title/branding from "Copilot cron"
- any `/cron-job` wording
- any Copilot-specific help text
- autostart/config/login hints

Keep:
- job list/detail
- run history
- SSE tail
- open/reveal file actions
- reload/stats/health views

## 10) Skill vs MCP

New `SKILL.md` should teach:
- This skill is for the **cron MCP server**, not local CLI commands.
- Use MCP tools for: list jobs, create job, update job, delete job, run now, view logs, status/health, migration.
- Never write files directly.
- Never assume Copilot CLI is installed.
- For prompt jobs, emit `llm-prompt` actions only through MCP.
- For scripts, prefer `script`/`exec`.
- Ask for explicit bounds on recurring jobs.
- Confirm destructive actions before delete/reset/migrate.

## 11) Backward compatibility / migration

Add:
```bash
cron migrate --from-copilot-ext
```

Behavior:
1. Detect `~/.copilot/cron`.
2. Copy/move jobs, logs, runs DB, config, dashboard assets as needed.
3. Rewrite v3 job schema to v4.
4. Preserve IDs, schedules, run history.
5. Leave a marker file in old home.
6. Support dry-run.
7. Print a migration report.

## 12) Risks & unknowns

- Node 22 `--experimental-sqlite` behavior may change; verify exact runtime requirement.
- `croner` v9 schedule semantics may differ for interval/cron edge cases.
- `--resume` flag naming for Copilot/agency may be wrong or unstable.
- VBS shim is Windows-only and brittle; confirm whether it is still needed.
- `copilot.exe` / `agency.exe` discovery logic is provider-specific and should be removed from core.
- Legacy layout migration from flat `jobs/*.json` to per-job folders is still present; confirm final migration path.
- SSE tailing assumes log file format and may need auth in standalone mode.
- Current HTTP API is localhost-only; decide whether MCP server should proxy or reuse it.
