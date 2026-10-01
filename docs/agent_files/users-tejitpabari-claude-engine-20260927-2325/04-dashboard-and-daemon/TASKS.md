---
status: draft
summary: Seven tasks - fixed daemon port with fallback, port surfacing, assistant-text-only run output, raw-log route, dashboard UI polish, id/alias/cwd display, then tests/docs/changeset.
date: 2026-10-01
---
# Tasks: Dashboard + Daemon Port (SP04)
Source of truth: docs/agent_files/users-tejitpabari-claude-engine-20260927-2325/04-dashboard-and-daemon/PRD.md. Cross-SP interfaces: SP05 Task 1 provides the shared job-log path helper that Task 4 consumes; SP03 provides the job `cwd`/`alias` terms and the corrected `Store.deleteJob` that Tasks 6-7 assume. No new runtime dependencies; no `SURFACE_CAPABILITIES` change (Decision 8).

| # | Task | Depends on | Status |
|---|---|---|---|
| 1 | Fixed default daemon port with fallback | - | todo |
| 2 | Surface the daemon port (ensure, status, info, doctor) | 1 | todo |
| 3 | Assistant-text-only run output contract | - | todo |
| 4 | Raw-log daemon route and `rawLogPath` | SP05 T1 | todo |
| 5 | Dashboard UI: theme icons, action alignment, run modal | 3, 4 | todo |
| 6 | Dashboard data display: full ids, Alias, working directory | 5 | todo |
| 7 | Tests, docs, reference, specs, changeset | 1-6 | todo |

## Task 1 — Fixed default daemon port with fallback
What it is / what it means: The daemon today binds an ephemeral port every start, so URLs break on restart. It should prefer a stable port, and always still work when that port is taken (Decisions 1, 2, 3).
What changes at a high level: Add the `DEFAULT_DAEMON_PORT = 47615` constant in the daemon constants module. Introduce an injectable port-binding step in daemon startup: try the preferred port on loopback; on address-in-use, probe the occupant with the existing health-signature check, emit one of the two PRD-specified messages (another crontick daemon with pid/data dir, or another non-crontick process) to stderr and the daemon log, then bind an OS-assigned port. Honor `CRONTICK_DAEMON_PORT` as the preferred-port override (tests only; no config.json option). Write the actually bound port to the existing `daemon.port` file in the same format.
Done when: Unit tests with fake listen/probe cover free, taken-by-crontick, taken-by-foreign, and env override; daemon starts on 47615 when free and falls back otherwise, with `daemon.port` holding the real port.

## Task 2 — Surface the daemon port (ensure, status, info, doctor)
What it is / what it means: Users and clients must learn which port the daemon landed on, and be told when it is not the default (Decision 2; R9).
What changes at a high level: `ensureDaemon`/`crontick daemon start` output reports "started on fallback port N; default 47615 is in use" when the port differs from the default. `daemon status` and `info` print port and dashboard URL (data already exists on the status endpoint). `doctor` gains a "daemon port" check that reads the port file, notes default versus fallback, and flags a foreign process on the default port when no daemon is running. Client discovery stays port-file based; `CRONTICK_DAEMON_URL` override unchanged. CLI shim changes are presentation only.
Done when: Each of the four outputs shows the expected port information in fallback and default cases; CLI/MCP/doctor all reach a daemon running on a fallback port in a test.

## Task 3 — Assistant-text-only run output contract
What it is / what it means: The shared run-output builder is the single place that decides what "output" means, reused by the dashboard and SP03's `runs get` (Decisions 6, 7).
What changes at a high level: Change the stream-json parsing so `RunOutput.output` is assistant text only: consecutive text blocks join into one segment, a tool-use between texts ends a segment, segments join with a `---` separator line, no leading or trailing separators, empty string when no text. Remove `[tool]` marker lines and keep thinking, hooks and tool results out. Plain text-format output, `result`, `error`, `stderr`, field names and per-segment redaction stay as they are. The output API route and the dashboard's "prepend result only if absent" behavior continue to work unchanged.
Done when: Unit tests cover text/tool/tool/text yielding two segments with a separator, consecutive texts without a separator, no `[tool]` anywhere, plain stdout unchanged, redaction per segment.

## Task 4 — Raw-log daemon route and `rawLogPath`
What it is / what it means: Browsers block `file:` links from http pages, so the dashboard needs a daemon-served raw log plus a displayable path (Decisions 4, 5).
What changes at a high level: Add `GET /api/runs/:id/log/raw` behind the existing loopback guard. It validates the run-id pattern, requires the run to exist, never derives a path from the URL, and returns the run's stored log chunks (all sources) concatenated and redacted, as plain text with inline disposition and no-sniff headers; unknown or malformed ids return 404. Expose `rawLogPath` (the per-job mirror path, null when file logging is off) on the run output endpoint and the dashboard run model, by reusing SP05's shared job-log path helper rather than adding a second resolver.
Done when: Route tests cover 200 with correct headers, 404 for unknown and `../x` ids, 403 off loopback, redaction applied; output endpoint returns `rawLogPath` or null.

## Task 5 — Dashboard UI: theme icons, action alignment, run modal
What it is / what it means: The visual items of the brief that touch the page shell and run detail (R1, R2, R4, R5).
What changes at a high level: Replace the three text theme buttons with icon-only monitor/sun/moon buttons keeping radiogroup semantics, `aria-checked`, theme-choice data attribute, aria-label and title, a visible focus ring, and unchanged persistence. Make row-action icon buttons share one inline-flex centered box so the run-now SVG and glyph buttons align. In the run modal remove the inline raw-log details block and its lazy loader; show meta, Error, Output (when non-empty) and a Raw log row with the path text (wrapping, copy icon), an Open link to the new route, and the muted caveat that the file holds all runs of the job. Rename "Session ID" to "Runner Session ID" in table header and modal meta.
Done when: Browser check shows three icons with labels and no visible text, action buttons within 1px vertical centers, modal without inline log and with working link, no "Session ID" label left.

## Task 6 — Dashboard data display: full ids, Alias, working directory
What it is / what it means: Remaining display items: untruncated identifiers and consistent alias/cwd presentation (R6, R7, R8).
What changes at a high level: Render full job ids in code elements that wrap anywhere, in the jobs table and run rows, keeping title and copy icon; short run refs in toasts stay short; adjust the id column so the page never scrolls horizontally at 360px. Use the term "Alias" in table, drawer, search placeholder and filter chips. Add `cwd` to the dashboard job model (top-level job cwd, falling back to `action.cwd`), show it in the drawer as "Working directory", and include it in search text. No change to deletion code; the dashboard route keeps inheriting SP03's store fix.
Done when: No truncated job ids in table or drawer; "Alias" and working directory visible; no horizontal page scroll at 360px.

## Task 7 — Tests, docs, reference, specs, changeset
What it is / what it means: Close out per AGENTS.md documentation and testing rules.
What changes at a high level: Add remaining tests: dashboard payload/route tests, a regression assertion that `/api/dashboard` excludes runs of a deleted job (active once SP03's store fix lands), and a DOM-level check for theme icons, labels and Runner Session ID. Update `docs/reference/` (CLI/daemon port, env var, HTTP routes), daemon and dashboard implementation docs, the relevant `docs/specs/` files, and the README port mention. Add a changeset (minor, pre-1.0). Run `npm run validate`.
Done when: `npm run validate` passes, docs describe the default port, fallback messages, raw-log route and output contract, and a changeset exists.
