---
status: approved
summary: Ten sub-projects to polish crontick CLI/dashboard and add config surfaces, job editor, after/webhook triggers, autostart, and opt-in catch-up.
date: 2026-10-07
---

# crontick-improvements brainstorm

## 1. TL;DR

Ten ordered sub-projects: CLI/dashboard polish, a `daemon.port` config key, config surfaces (CLI/MCP/API/Settings UI), a dashboard job editor, `--after` and `--webhook` triggers, opt-in autostart on Linux/macOS/Windows, and opt-in catch-up. No backward-compat constraints (no external users), so removals are outright. Autostart reintroduction is explicitly signed off by the owner (AGENTS.md rule 8).

## 2. Problem

Verified facts in code:

| Area | Fact |
|---|---|
| Port | Default 47615 (`src/constants/daemon.ts`); override only via env `CRONTICK_DAEMON_PORT` (`src/daemon/bind-port.ts`); silent random-port fallback on EADDRINUSE |
| Dashboard | Plain HTML/CSS/JS in `src/dashboard/`, served by daemon HTTP (`src/daemon/api.ts`); API on 127.0.0.1 with loopback remoteAddress check; no token/CSRF/Origin checks; `PUT /api/jobs/:id` exists |
| Config | `<dataDir>/config.json` (`src/config.ts`, `src/schemas/config.ts`); library methods only, no CLI/MCP/API |
| Engine cmd | Resolved from config per run (`resolvePromptRunCommand`); job stores engine name only |
| Defaults | timeout/overlap/retry/engine baked into jobs at create; `retention.maxRunsPerJob` applied on daemon reload |
| Runs | SQLite `runs.db`, `runs.job_id` has no FK |
| Job lookup | `Store.getJob(idOrAlias)` (`src/daemon/store.ts`) resolves id/alias only inside daemon |
| Autostart | Removed in PR #16 (native registry-js, EDR flag on Windows Run key + hidden VBS shim, surprise background process); guarded by `tests/unit/autostart-removal.test.ts`, ADR 0001, spec R-004-35 |
| Missed fires | Recorded as `missed`, never replayed (ADR 0015) |
| Daemon reach | Loopback-only, demand-started: external webhooks cannot reach it |
| Run completion | No hook; choke point is `recordRunOutcome` in `src/daemon/runner.ts` |

## 3. Decision log

### Global

| Decision | Alternative rejected | Why |
|---|---|---|
| No backward compat; remove outright, no aliases/deprecations | Deprecation period | No external users |
| One shared id-or-alias resolver (extracted from `Store.getJob`) used everywhere a job is referenced | Per-surface lookup | Consistency; one place to fix |
| `runs delete --job` on orphan runs falls back to raw job id | Require alias | Deleted job's alias is unrecoverable |
| Every capability in client + CLI + MCP + `SURFACE_CAPABILITIES` (+ API if daemon-backed) | Partial surfaces | AGENTS.md parity rule; surface-drift test |
| API stays local-only; minimal hardening, no tokens | Token auth | Loopback-only product; tokens add friction |

### Per item

| # | Decision | Alternative rejected | Why |
|---|---|---|---|
| 1 | Config key `daemon.port`; unset = 47615 + random fallback; set and busy = start fails with clear error; env var removed; no `--port` flag; read-only in settings/CLI/MCP (hand-edit + restart) | Keep env var; `--port` flag; silent fallback when set | One source of truth; explicit port must be honored or fail loudly |
| 2 | Dashboard zoom ~80% (body 18px to ~14px, proportional) | Leave as is | Owner preference |
| 3 | Header: drop node version, job count, "up Xm" badge; keep `v... · pid ...`; red badge when daemon unreachable | Remove all status | Keep the useful failure signal |
| 4 | `jobs new` help: `--cron` "Schedule: cron expression, e.g. \"0 9 * * *\""; `--every` "Schedule: repeat every N seconds, or use an s/m/h/d suffix (e.g. 30m)"; `--at` "Schedule: one-shot run time, ISO-8601 (e.g. 2026-10-01T09:00)"; shared with `jobs update`; footer only on `jobs new`: "use exactly one of --cron, --every, --at, --after, --webhook" | Footer on update too | Update does not choose a schedule from scratch; after/webhook added by their SPs |
| 5 | `-C, --cwd <dir>` becomes `-d, --dir <path>` "Directory the job runs in (default: current directory)"; no alias; `action.cwd`, MCP, `--file`, dashboard keep `cwd` | Keep both flags | No compat concern; field name unchanged to avoid migration |
| 6 | `runs delete <runId...>` or `--job <id\|alias>`; scans runs by job_id (works if job gone); deletes run_outputs, and orphan job log if job absent; skips queued/running and reports; confirm prompt, `--force` skips; client+CLI+MCP+API, not dashboard | Dashboard delete; FK cascade | Orphans have no FK; dashboard out of scope |
| 7 | `crontick config list\|get\|set\|unset` + MCP + API; all keys editable incl. engines except `daemon.port`; auto daemon reload after save; warn: edits do not affect running runs, defaults apply only to new jobs | Restrict editable keys | Full control; warning sets expectations |
| 8 | Dashboard Settings: gear top-right; Edit button enables editing; bottom Save (edit mode only) + Cancel (always); Cancel with unsaved changes asks "changes will be lost"; Save writes config.json via API | Always-editable form | Prevents accidental edits |
| 9 | Job editor: "+" creates, pencil per job edits all CLI-settable fields (schedule kinds, dir, engine, session, timeout, overlap, retry, desc, args); enable/disable, delete, run-now stay outside; directory required on create, prefilled on edit | Inline editing; defaulting to daemon cwd | Daemon cwd is meaningless |
| 10 | API hardening: mutating requests need Host 127.0.0.1/localhost/[::1] (with port), Content-Type application/json, Origin (if present) matching daemon origin; no tokens | Tokens; CSRF cookies | Blocks DNS-rebinding and cross-site POST cheaply |
| 11 | `--after <job>`: new schedule kind, exclusive with cron/every/at/webhook; single upstream; `--after-status success\|failure\|any` (default success); fires on any terminal upstream run (scheduled/manual/webhook) after retries; skipped/missed/canceled do not trigger; cycles rejected at create/update; deleting upstream with dependents refused unless `--force` (disables dependents); downstream gets upstream run id + status as env; client/CLI/MCP/API/dashboard | Multiple upstreams; cascading delete | Keep model simple; safe deletes |
| 12 | `--webhook` kind with optional `--relay <url>`: daemon opens outbound SSE to smee.io-style relay, fires per event; local `crontick jobs trigger <job> [--payload json]` + MCP + `POST /api/jobs/:id/trigger`; payload appended to prompt as fenced JSON (cap 64KB) and in env `CRONTICK_EVENT`; filtering left to prompt; dashboard Webhook option + trigger/relay info | Public inbound listener; local-only | Inbound breaks loopback-only; local-only cannot receive GitHub |
| 13 | AutoStart reintroduced (owner sign-off, rule 8; opt-in, no native deps, no Run key/VBS, no admin): `crontick autostart enable\|disable\|status` + MCP/client; starts at user login; Linux systemd --user unit; macOS LaunchAgent (`~/Library/LaunchAgents`, `launchctl bootstrap`); Windows schtasks logon task `\crontick\daemon` running signed node.exe directly; rewrite removal test to ban only registry-js, reg.exe, Run key, hidden VBS; update ADR 0001, spec R-004-35, add new ADR; skip Apple signing | Registry Run key; VBS shim; boot-time start; Developer ID signing | Original removal causes avoided; admin-free; transparent to EDR |
| 14 | Per-job opt-in `--catch-up`: on daemon start, if >=1 fire missed, run once; remaining missed recorded `skipped`; default off (ADR 0015 amended) | Default on; replay all | Avoid surprise runs/storms |

## 4. Design

| SP | Scope | Depends on |
|---|---|---|
| 01-cli-polish | Help text + footer, `-d/--dir`, shared id/alias resolver, `runs delete` | none |
| 02-port-and-dashboard-polish | `daemon.port` config, env var removal, zoom, header | none |
| 03-config-surfaces-and-settings | Config CLI/MCP/API + Settings UI | 02 |
| 04-dashboard-job-editor | "+" create, pencil edit, API hardening | 03 (shared dashboard files) |
| 05-after-trigger | `--after` kind | 01, 04 |
| 06-webhook-trigger | `--webhook`, relay, `jobs trigger` | 01, 04 |
| 07-autostart-core-linux | Autostart command, client/MCP, systemd, test/ADR/spec rewrite | none |
| 08-autostart-macos | LaunchAgent | 07 |
| 09-autostart-windows | schtasks logon task | 07 |
| 10-catch-up | `--catch-up` | none |

Execution order (max 2 parallel; same-file work sequential): 01 || 02 -> 03 -> 04 -> 05 || 07 -> 06 || 08 -> 09 || 10.

## 5. Non-goals

- Other triggers (file-watch, command-change/poll, on-daemon-start)
- Apply-new-defaults-to-existing-jobs action
- Apple signing/notarization
- Boot-before-login start
- Webhook event filtering
- Dashboard run delete
- Auth tokens / remote access

(Deferred items tracked in `docs/agent_files/futures.md`.)

## 6. Open risks

| Risk | Cheapest test |
|---|---|
| smee-style relay availability/trust (third party) | smee.io channel + GitHub test delivery |
| macOS untestable in CI | Owner manual test on a Mac |
| Windows EDR may still flag schtasks | Windows CI + owner machine |
| New schedule kinds break missed-fire enumeration | Unit test `enumerateFiresBetween` with after/webhook kinds |
| Surface parity drift per SP | `tests/unit/surface-drift.test.ts` green per SP |

## 7. Manual steps for owner

- Test autostart on a real Mac; approve in System Settings -> Login Items if prompted.
- IT allowlist on corporate Windows if flagged (else Defender false-positive submission).
- Configure GitHub webhook to point at the relay URL.
- Sign off rule-8 autostart reintroduction in the PR description.
