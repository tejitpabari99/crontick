---
status: draft
summary: Eight tasks - daemon.port config schema, explicit-port bind semantics with DAEMON_PORT_IN_USE, startup/CLI surfacing, status/doctor reporting, env-var removal with per-home test isolation, dashboard rem scale, header trim, then docs/changeset/validate.
date: 2026-10-08
---
# Tasks: Port config + dashboard polish (SP02)
Source of truth: docs/agent_files/users-tejitpabari-crontick-improvements-20261007-0034/02-port-and-dashboard-polish/PRD.md. No dependency on other sub-projects; SP03 builds on the `daemon` config section and the rem scale defined here. No new capability, so `SURFACE_CAPABILITIES` is untouched; no new runtime dependencies.

| # | Task | Depends on | Status |
|---|---|---|---|
| 1 | `daemon.port` config schema | - | todo |
| 2 | Port resolution and bind semantics | 1 | todo |
| 3 | Daemon startup wiring and failure surfacing | 2 | todo |
| 4 | Port reporting in status, info, doctor | 2 | todo |
| 5 | Remove env var and isolate tests per home | 1-4 | todo |
| 6 | Dashboard rem scale | - | todo |
| 7 | Dashboard header trim and error badge | 6 | todo |
| 8 | Docs, changeset, full validation | 1-7 | todo |

## Task 1 — `daemon.port` config schema
What it is / what it means: The port becomes a config-file setting instead of an env var; `daemon` becomes a known, strictly validated config section (R1, D2, D6; RESOLVED-1).
What changes at a high level: Add a `daemon` section with an optional integer `port` (0 to 65535, strict, no unknown keys) to the runtime and persisted config schemas, exporting a persisted-daemon schema that SP03 will reuse. The built-in config carries an empty `daemon` section so an absent port means "unset". The default config template is not changed, so the config file is never auto-written with a port. Invalid values fail config loading with the existing config error; there is no silent fallback. Port 0 is valid and means OS-assigned.
Done when: Config tests show `{"daemon":{"port":N}}` loads, 70000, "abc" and unknown `daemon.*` keys are rejected, and `ensureConfigFile` output has no `daemon.port`.

## Task 2 — Port resolution and bind semantics
What it is / what it means: Core behavior split between "unset" (today's soft fallback) and "explicit" (honor or fail loudly) (R2, R3, R4, D1, D6).
What changes at a high level: Preferred-port resolution takes the config and returns a port plus an explicit flag (unset gives 47615 and not explicit); the env var is no longer read. The bind step takes that preference. Unset behaves exactly as today (in-use, probe, notify, bind OS-assigned). Explicit non-zero port in use: probe the occupant and throw a new `DAEMON_PORT_IN_USE` error, with no fallback; message names the port, the `daemon.port` config key, the occupant (crontick pid and data dir, or "not crontick") and the config path, with details carrying port, occupant, configPath. A crontick occupant with the same data dir gets a "run `crontick daemon stop`" variant. Explicit 0 binds silently with no fallback note. Other listen errors (e.g. EACCES) rethrow, still naming port and config key.
Done when: Unit tests with fake listen/probe cover unset free/busy, explicit busy by foreign, by other-dir crontick and by same-dir crontick, explicit 0, and EACCES rethrow.

## Task 3 — Daemon startup wiring and failure surfacing
What it is / what it means: Make the explicit-port failure reach the user through the existing start path without new ensure logic (R5, RESOLVED same-data-dir, RESOLVED running-daemon).
What changes at a high level: The daemon's listen block reuses the config already loaded at startup to resolve the port preference. A config reload must not rebind; `daemon.port` is read at startup only. Confirm the existing catch-log-exit-1 path puts the error on stderr and in the ensure log, and that the existing start-failed error carries the tail. A second invocation for the same data dir still connects to the running daemon through the port-file probe and single-instance check, not an error.
Done when: A CLI-level integration test with an occupied explicit port shows `daemon start` exiting non-zero with the DAEMON_PORT_IN_USE text, and a second ensure for the same data dir connects cleanly.

## Task 4 — Port reporting in status, info, doctor
What it is / what it means: Reporting follows the config-based model, including the stale-config case (R6, D8).
What changes at a high level: The port-description helper takes the config: explicit port gives no fallback note, unset with a non-default running port keeps the existing note, explicit 0 gives none. `doctor`'s daemon port check reads the config, shows the port as coming from config when explicit, and warns that the daemon will fail to start when a foreign process holds an explicit port. `daemon status` and `info` show a "config says X, running on Y" note when the two differ, via comparison only with no new fields.
Done when: Updated tests for the helper, doctor, status and info use config-based inputs and cover the mismatch note.

## Task 5 — Remove env var and isolate tests per home
What it is / what it means: Delete `CRONTICK_DAEMON_PORT` everywhere and keep the suite from contending for 47615 (R7, D7; RESOLVED-2).
What changes at a high level: Remove all env references from source, the constants comment and the vitest config. Add a shared test helper that writes a config with `daemon.port` 0 into a test home, and call it from every site that spawns a real daemon (port tests, ensure tests, integration/e2e helpers). No source-scanning guard test; an omitted call degrades to the default port with fallback rather than breaking. Rewrite the three env-based port test files to use config.
Done when: The grep for the env var across src, tests, vitest config and docs (excluding changelog and agent files) returns nothing, and the full suite passes with no port env set.

## Task 6 — Dashboard rem scale
What it is / what it means: Shrink the dashboard to about 80% through one tunable root scale so later settings and editor UI inherit it (R8, D3; RESOLVED-5).
What changes at a high level: Define a root scale variable of 0.8 and a root font size of 18px times that scale. Mechanically convert pixel font sizes, paddings, gaps and widths in the dashboard stylesheet to rem at old-px over 18; 1px borders stay in px. No CSS `zoom`, no layout or theme changes. Scale stays 0.8 unless screenshot review says otherwise (one-variable change).
Done when: Computed body size is about 14.4px and h1 about 17.6px, no px font-sizes remain, and a screenshot review shows no layout breakage.

## Task 7 — Dashboard header trim and error badge
What it is / what it means: A quieter header that signals only failure (R9, D4, D5).
What changes at a high level: The version line renders exactly version and pid with the middle-dot separator; node version, job count and uptime text are removed. The health badge is hidden on success and shown in the error style with the failure message when the data fetch fails. The now-unused uptime formatter is removed. The health data shape is left intact (all fields kept) since it is shared with `/health`, the probe and the public type. Dashboard tests are updated.
Done when: Header shows only `v<ver> · pid <pid>`; with the daemon unreachable a red badge shows the error; health tests still pass.

## Task 8 — Docs, changeset, full validation
What it is / what it means: Close-out per repo rules (R7 docs, R10).
What changes at a high level: Configuration reference gets a `daemon.port` section replacing the env row. Daemon spec updates R-004-1 and adds R-004-1a for explicit ports. Daemon implementation doc and troubleshooting cover the new error and restart-required behavior; changelog history is untouched. Add a minor changeset (config schema addition, env removal). Run `npm run validate`.
Done when: `npm run validate` passes, docs match behavior, a changeset exists, and the PRD acceptance greps and checks are satisfied.

Closing note: manual step, a human screenshot review of the dashboard scale (Task 6/7) to confirm 0.8 or tune it; Windows behavior for reserved port ranges (EACCES) is untested and should be verified on a Windows machine during implementation (RESOLVED-3).
