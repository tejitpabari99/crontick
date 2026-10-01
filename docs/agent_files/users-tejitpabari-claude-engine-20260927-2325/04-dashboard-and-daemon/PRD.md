---
status: done
summary: Dashboard polish (icon theme switcher, action alignment, text-only run output, raw-log link, full job ids, Runner Session ID, alias/cwd) plus a fixed default daemon port with occupied-port fallback.
date: 2026-10-01
---
# PRD: Dashboard + Daemon Port (SP04)
Repo/branch: `/root/projects/crontick` · `users/tejitpabari/claude-engine` · Depends on: SP01 (done); SP03 interfaces (assumed, below) · Owns: `src/dashboard/{index.html,dashboard.css,dashboard.js}`, `src/dashboard.ts`, `src/run-output.ts`, `src/daemon/{index,api,ensure}.ts` (port + raw-log route only), `src/constants/daemon.ts`, `src/doctor.ts`, docs.

## TL;DR
Nine owner requests. Seven are dashboard-only edits; one fixes the shared `buildRunOutput` so the dashboard and SP03's `runs get` both show assistant text only (segments joined by `---`); one makes the daemon bind a fixed default port `47615`, falling back to a free port with a clear message when it is taken, recording the real port in `daemon.port`.

## Problem
- Theme control is text buttons. Run-now icon sits higher than its siblings. Output shows `[tool] Bash` noise. The run modal inlines the raw engine log. "Session ID" is ambiguous. Job ids are cut to 12 chars. Daemon port is a new random port each start, so bookmarks and the dashboard URL break on every restart.

## Goals / Non-Goals
Goals: items 1-9 of the brief. Non-goals: CLI flags/options, share export/import, job-model/cwd/alias field changes (SP03); usage/cost/hooks (SP05); new runtime deps; any auth change (loopback-only stays).

## Verified current behavior
| Claim | Evidence |
|---|---|
| Theme switcher is 3 text buttons `System/Light/Dark` in `#theme-toggle` | `[verified: src/dashboard/index.html:21-23]` |
| Run-now alignment cause: its button holds an `<svg>` forced `display:block` (`.run-now-btn svg`) while siblings are text/emoji glyphs (`⏹`, `🗑`) at `font-size:14px; line-height:1` in inline-block buttons, so baseline alignment places the glyph buttons and the svg button differently | `[verified: dashboard.css:181-200, 392; dashboard.js:160-173]` |
| `[tool] <name>` lines come from `parseStdout`'s `transcript.push(\`[tool] ${name}\`)`, emitted in `RunOutput.output`; `/api/runs/:id/output` returns it; modal renders `output` (prefixing `result` if absent) | `[verified: run-output.ts parseStdout; api.ts:303-307; dashboard.js:511-536]` |
| Raw log today: DB-backed. Runner stores engine stdout/stderr chunks in SQLite `run_logs` (per run) and mirrors them to ONE file per job, `<logsDir>/<safe jobId>.log` (all runs appended; `logging.dir`/`fileEnabled` configurable). Dashboard lazily fetches `GET /api/runs/:id/logs?source=all` into a `<pre>` on `<details>` toggle | `[verified: run-output.ts header; job-log-file.ts:44-75; store.getLogs:828; dashboard.js:545-556]` |
| Port: daemon calls `server.listen(0,'127.0.0.1')` (ephemeral), writes `daemon.port` (plain integer), deletes it on cleanup. Clients: `readPortFile` → `http://127.0.0.1:<port>`, `probeHealth` validates the crontick signature. `doctor` only checks the port file exists. `/api/daemon/status` already returns `port`/`baseUrl`; `crontick info` prints dashboard URL | `[verified: daemon/index.ts:330-339; ensure.ts:52-70,268,335; doctor.ts:64; api.ts:371-377]` |
| "Session ID" header and `Session:` meta label; job id shown `shortId()` (12 chars + `…`) in jobs table; drawer shows full id; recent-runs drawer list uses 8 chars | `[verified: index.html:105; dashboard.js:89,164,296,460,523]` |
| Dashboard label for alias is "Alias" in table, "Name" in drawer; drawer already shows `action.cwd` ("Working dir") | `[verified: index.html:39; dashboard.js:435,444]` |
| Single-job delete (`DELETE /api/jobs/:id`) calls `store.deleteJob` (archives runs, i.e. they survive), then unschedule + `runner.cancelJob`; bulk delete wipes runs | `[verified: api.ts:206-216; store.ts:388-405]` |

## Requirements
**R1 Theme icons.** Same `role=radiogroup`/`radio` + `aria-checked` + `data-theme-choice` markup, but each button holds an inline SVG (monitor / sun / moon, `currentColor`, `aria-hidden`) with `aria-label` ("System theme" etc.) and `title`. Visible focus ring; no visible text. localStorage behavior unchanged.

**R2 Action alignment.** `.actions-cell .icon-btn { display:inline-flex; align-items:center; justify-content:center; vertical-align:middle; width:26px; height:26px; padding:0 }` so svg and glyph buttons share one box; keep `.run-now-btn svg{display:block}`.

**R3 Output contract (shared, `src/run-output.ts`).** `RunOutput.output` becomes "assistant text only": for `claude-stream-json`, collect assistant `text` blocks in order; consecutive text with no intervening `tool_use` form one segment (joined `\n\n`); a `tool_use` between texts ends the segment; segments are joined by `\n\n---\n\n`. No `[tool]` lines, no thinking, hooks, tool results; leading/trailing separators never emitted; no text at all → `''`. Plain (`text` format) output is unchanged (lines as-is). `result`, `error`, `stderr` semantics unchanged; `cleanOutputText` redaction still applies per segment. Field name/shape stays, so `GET /api/runs/:id/output` and the dashboard keep working, and SP03's `runs get` prints `RunOutput.output` (and `error`) directly with no re-parsing. Dashboard still prepends `result` only when `output` doesn't contain it. Tool markers have no replacement (owner request); the raw log is the escape hatch.

**R4 Run detail.** Modal shows: meta line, **Error** (if any; error + stderr), **Output** (if non-empty), **Raw log** row: absolute path as text (`<code>`, wraps, copy icon) plus an "Open" link `href=/api/runs/:id/log/raw target=_blank rel=noopener`. The inline `<details>`/`loadRawLog()` and its `<pre>` are removed.
- New route `GET /api/runs/:id/log/raw`: loopback-only (existing guard), `:id` must match the run-id pattern and exist in the store (never builds a path from the URL), returns `text/plain; charset=utf-8`, `Content-Disposition: inline; filename="<runId>.log"`, `X-Content-Type-Options: nosniff`, body = the run's `run_logs` (all sources) concatenated, passed through `redactText`. `file://` is rejected as the link target: browsers block `file:` navigation from `http:` pages.
- Path shown: the per-job mirror `<logsDir|logging.dir>/<safeJobId>.log`, resolved by a helper next to `safeLogFileName` and returned as `rawLogPath` on `/api/runs/:id/output` (and `DashboardRun`), `null` when `logging.fileEnabled=false` (UI then shows only the Open link). Caveat shown as muted text: "file holds all runs of this job; the link serves this run only."

**R5** Rename "Session ID" → "Runner Session ID" (table header, modal meta; drawer if shown).

**R6 Full job id.** Jobs table and run rows render the full id in `<code>` with `overflow-wrap:anywhere` (replacing `shortId` for display; `title` and copy icon stay). `.id-cell` drops `nowrap` for the id column; `.table-wrap{overflow-x:auto}` already contains the table, and at <=640px the id cell may wrap, so the page itself never scrolls horizontally. Toast/short refs (`slice(0,8)` run ids) stay short.

**R7 Alias + cwd.** Assumption: SP03 keeps the stored field `alias` and the user-facing term "Alias" (`../03-cli-and-job-model/PRD.md` did not exist when this PRD was written). Dashboard uses "Alias" everywhere (table, drawer `Name`→`Alias`, search placeholder, run filter chips), and adds `cwd` to `DashboardJob` (from SP03's top-level `job.cwd`, falling back to `action.cwd` while both exist) shown in the drawer as "Working directory" and in search text. If SP03 renames the label, only these strings change. Drawer and `/api/jobs/:id` already accept id or alias (`Store.getJob`); no change.

**R8 Deletion.** No redesign. Interface assumption: SP03 fixes the shared `Store.deleteJob` / client `deleteJob` semantics (so deleted jobs' runs no longer surface in `runs list`/dashboard); the API route keeps calling `store.deleteJob` + `scheduler.unschedule` + `runner.cancelJob`, so it inherits the fix. SP04 only adds a regression assertion that dashboard data (`/api/dashboard`) excludes runs of a deleted job once SP03 lands.

**R9 Fixed daemon port.** `DEFAULT_DAEMON_PORT = 47615` in `src/constants/daemon.ts` (outside the Linux ephemeral range 32768-60999 and IANA-registered services).
- Startup: try `listen(preferred,'127.0.0.1')`. On `EADDRINUSE`: probe `GET /health` on that port with the existing signature check; print to stderr + daemon log either `Port 47615 is in use by another crontick daemon (pid N, data dir ...); starting on a free port` or `Port 47615 is in use by another process (not crontick); starting on a free port`; then `listen(0)` and use the OS-assigned port. Process owner is not detected (would need `lsof`/platform tools); the message says "another process".
- Write the actual bound port to `daemon.port` after listen succeeds (existing file, same format). A fallback port is therefore discovered exactly as today (clients read the file; never assume the default). `CRONTICK_DAEMON_URL` override unchanged.
- `ensureDaemon` after spawn already waits for the port file; the daemon logs the notice into the daemon log, and `ensureDaemon` surfaces it via `crontick daemon start` output when `port !== DEFAULT_DAEMON_PORT` ("started on fallback port N; default 47615 is in use").
- `crontick daemon status` and `info` print port and the dashboard URL (`http://127.0.0.1:<port>/`); `doctor` gains a check "daemon port" (reads file; note says default/fallback and flags a foreign process on the default port when no daemon runs).
- Test/override: env `CRONTICK_DAEMON_PORT` sets the preferred port (tests use `0`-style free ports so parallel test daemons never fight over 47615). No `config.json` override.

## Architecture
```
daemon/index.ts: bindPort(server, preferred) -> {port, fellBack, occupant}   // injectable listen/probe
   -> ctx.port, writeFileSync(portFilePath, port)
run-output.ts: parseStdout -> segments[] ; output = segments.join('\n\n---\n\n')
api.ts: GET /api/runs/:id/log/raw (new), /output gains rawLogPath
dashboard.js: render only; no business logic
```
`bindPort` and the segment joiner are pure/injectable for unit tests (AGENTS rule 6).

## Decisions
| # | Decision | Choice | Alternatives | Why |
|---|---|---|---|---|
| 1 | Default port | 47615 | 3000-ish, 8080 | Unlikely collisions, outside ephemeral range |
| 2 | Occupied behavior | Message + OS-assigned free port | Fail hard; scan upward | Always works; discovery already via port file |
| 3 | Config port override | None; env `CRONTICK_DAEMON_PORT` for tests | `config.json daemon.port` | Smaller surface, no parity rows; revisit if requested |
| 4 | Raw log link | Daemon route, not `file://` | file:// link | Browsers block file: from http pages |
| 5 | Raw log content | Per-run from `run_logs` | Serve per-job mirror file | Mirror mixes runs, may be disabled |
| 6 | Tool noise | Dropped entirely, `---` marks breaks | Keep collapsed markers | Owner request |
| 7 | Contract location | `buildRunOutput` | Dashboard-side filter | SP03 reuses without duplication |
| 8 | Surface parity | New route is dashboard-only HTTP, no `SURFACE_CAPABILITIES` row | New client method | Not a user capability; `output` already exposed via existing client method |

## Manual steps
None.

## Risks / Open Questions
- Existing bookmarks/scripts assuming a random port: none rely on it (all go through the port file). [RESOLVED: no action]
- Two data dirs on one machine: second daemon falls back to a free port and reports the first as "another crontick daemon". [RESOLVED: expected]
- Stale `daemon.port` from a crashed daemon: unchanged behavior; `probeHealth` rejects it and `ensureDaemon` respawns. [RESOLVED]
- Race between probe and listen of the fallback: `listen(0)` is atomic, no race. [RESOLVED]
- `/log/raw` size: capped by existing `maxOutputBytesPerRun`; stream in one response. [RESOLVED]
- Final alias label depends on SP03. [RESOLVED: assume "Alias"; string-only change if different]
- Per-run raw file on disk (instead of DB-backed) [DEFERRED]

## Acceptance Criteria
- Theme control shows 3 icons, each with aria-label/title, keyboard operable, persists choice; no text visible.
- In a browser, the three row-action buttons share one vertical center (computed bounding boxes within 1px).
- Unit test: stream with text,tool_use,tool_use,text gives `"A\n\n---\n\nB"`; no `[tool]` anywhere; consecutive texts do not get `---`; plain stdout unchanged. `/api/runs/:id/output` reflects it.
- Run modal has no inline raw log; shows path text + working link; `/api/runs/:id/log/raw` returns `text/plain`, inline disposition, 404 for unknown/malformed ids (`../x`), 403 off loopback.
- "Runner Session ID" appears; no "Session ID" label remains. Job ids are never truncated in tables/drawer; at 360px width no page-level horizontal scroll.
- Daemon starts on 47615 when free; with 47615 held by a plain TCP listener it prints the foreign-process message, starts on another port, writes it to `daemon.port`, and CLI/MCP/`doctor`/`daemon status` reach it; with a crontick daemon on 47615 (other data dir) the message says so.
- Dashboard shows "Alias" and the job working directory; deleting a job via the dashboard leaves no runs for it in `/api/dashboard` (given SP03's store fix).
- Docs (`docs/reference/`, dashboard/daemon internals, README port mention) and a changeset updated; `npm run validate` passes.
