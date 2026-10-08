---
status: draft
summary: Six tasks - autostart core (backend interface, service, drift), supervised exit-0 and daemon start --home, Linux systemd backend, client/CLI/MCP-status/surface wiring, removal-guard reversal, docs/ADR/changeset.
date: 2026-10-08
---
# Tasks: SP07 AutoStart core + Linux
Source of truth: docs/agent_files/users-tejitpabari-crontick-improvements-20261007-0034/07-autostart-core-linux/PRD.md. No [OPEN] items remain. One item is [DEFERRED: verify during implementation] (SIGTERM exit code, folded into Task 2). The other [DEFERRED] items (linger management, multiple data dirs, `systemd-analyze verify` in CI) are out of scope. No new runtime dependencies. SP08 and SP09 consume the interface, spec, supervised contract, `--home` option and ADR 0034 from this sub-project.

| # | Task | Depends on | Status |
|---|---|---|---|
| 1 | Autostart core: types, service, factory, drift | - | todo |
| 2 | Supervised already-running exit 0, SIGTERM check, `daemon start --home` | - | todo |
| 3 | Linux systemd backend and unit renderer/parser | 1 | todo |
| 4 | Client methods, CLI group, MCP status, surface parity exception | 1, 3 | todo |
| 5 | Reverse the removal guards | 4 | todo |
| 6 | Docs, ADR 0034, spec rewording, changeset, validate | 1-5 | todo |

## Task 1 — Autostart core: types, service, factory, drift
What it is / what it means: The platform-neutral layer SP08/SP09 plug into (D2, D9, R3, R4, R6, R7).
What changes at a high level: New `src/autostart/` types (spec incl. `cliScript`, deps, inspection, backend with optional `expectedCommand`, status), a factory switching on injected platform (Linux only for now, else undefined), and `AutostartService`. The service builds the spec in `buildSpec` (node path, daemon script, `cliScript`, env of `CRONTICK_SUPERVISED=1`, `CRONTICK_HOME` only if set, PATH snapshot), calls `available()` first, maps failures to `CrontickError`, and computes status including drift against `expectedCommand` or the daemon script. Enable refuses when the script is missing or the path is ephemeral (`_npx`). Unsupported platform: status returns `supported:false` with a reason, enable/disable throw `AUTOSTART_UNSUPPORTED`. Status carries a re-run-enable hint for stale PATH. Types exported via `src/index.ts`.
Done when: Unit tests with fake exec/fs cover spec building, drift on node/script/`CRONTICK_HOME` change, unsupported status vs enable error, missing-script and `_npx` refusal, and idempotent disable returning `removed:false`.

## Task 2 — Supervised already-running exit 0, SIGTERM check, `daemon start --home`
What it is / what it means: Prevents a supervisor crash-loop when a demand-started daemon already runs, and carries the data dir where env cannot (D4, R8, R5).
What changes at a high level: Add the `CRONTICK_SUPERVISED` name constant in `src/constants/daemon.ts`; in the daemon's already-running branch, exit 0 when it is set, non-zero otherwise. Add `daemon start --home <dir>` as a thin CLI option passed to the client, which sets `CRONTICK_HOME` for the daemon it spawns. `daemon start` still registers nothing.
Done when: Regression tests show a second start exits 0 only when supervised and non-zero otherwise, and `--home` sets `CRONTICK_HOME` for the spawned daemon. Verify the daemon exits 0 on SIGTERM through its shutdown path (so graceful stop is not restarted by `Restart=on-failure`) and add a test; if it does not, fix the shutdown exit code as part of this task.

## Task 3 — Linux systemd backend and unit renderer/parser
What it is / what it means: The first real `AutostartBackend`, writing a readable user unit (D3, D5, D6).
What changes at a high level: A pure renderer/parser produces and reads the unit (direct node plus daemon script, `Environment=` for supervised/home/PATH, `Restart=on-failure`, `RestartSec=5`, `KillMode=process`, `WantedBy=default.target`) with systemd escaping (quoted args, `%%`, `$$`). The backend uses `${XDG_CONFIG_HOME:-~/.config}/systemd/user/crontick.service`. `available()` checks `systemctl --user show-environment`; install writes, reloads, `enable --now`, and restarts if changed while active; uninstall disables, removes, reloads; inspect parses the unit and reads is-enabled/is-active plus linger as a hint. Backends report, never compare. Registered in the factory.
Done when: Fake-exec tests cover rendering and escaping, round-trip parse, install/uninstall idempotency, unavailable systemd writing nothing, and the linger hint; no test touches real systemd.

## Task 4 — Client methods, CLI group, MCP status, surface parity exception
What it is / what it means: Expose the feature with no daemon route (D1, D7, R1, R5).
What changes at a high level: Three client methods calling the service directly with real deps injected; a CLI `autostart enable|disable|status` group that only formats the returned object; one MCP tool, `crontick_autostart_status`, returning the status as JSON. Add three `SURFACE_CAPABILITIES` entries, with enable/disable carrying an explicit MCP exemption, and update `surface-drift.test.ts` to encode that exception while still failing on any other missing surface.
Done when: CLI and client tests pass; MCP lists only the status tool; `surface-drift` is green and demonstrably fails when another surface is removed.

## Task 5 — Reverse the removal guards
What it is / what it means: The owner signed off rule 8 reintroduction; the guard must stop banning autostart but keep banning the old risky mechanisms (Guard reversal).
What changes at a high level: Rewrite `tests/unit/autostart-removal.test.ts`: keep the `registry-js` dependency check and the unrelated needles, drop `autostart` and `login item`, add `hkcu`, `currentversion\run`, `wscript`, `.vbs`; update the failure message and the stale comment in the CLI index.
Done when: The guard passes on the tree and fails when a `registry-js`, `reg.exe`, Run key or `.vbs` string is planted.

## Task 6 — Docs, ADR 0034, spec rewording, changeset, validate
What it is / what it means: Close out per AGENTS.md documentation rules and the acceptance criteria (D8).
What changes at a high level: Update `docs/reference/{cli,mcp,library}.md` (incl. `--home`, the MCP status-only exception and the lifecycle caveat that without linger jobs pause while logged out). Add ADR 0034 as a README index row with its body as a section in ADR 0001; update `docs/tech/mission.md`, `docs/concepts/daemon-lifecycle.md`, and `docs/specs/004-daemon.md` so R-004-35 says `daemon start` does not register and `autostart enable` does. Document disabling before uninstalling the package. Add a changeset. Run `npm run validate`.
Done when: `npm run validate` passes, docs match behavior, changeset exists, and ADR 0034 is indexed for SP08/SP09 to extend.

## Manual steps
Owner: sign off rule 8 reintroduction in the PR description; run enable, disable and a reboot/login check on a real Linux desktop (systemd --user, no linger) and record the result.
