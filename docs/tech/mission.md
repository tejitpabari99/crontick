# Mission & Tenets

> This is crontick's guiding spirit — the standard design decisions get checked against. It is a **living doc**: when reality moves, update it here, not just in code.

## Mission

crontick lets you schedule AI agent work locally, from a config you define, and have it actually run. Most agent CLIs offer an in-session loop (`/loop`, "run this every N minutes") that lives and dies with that one session. crontick runs outside any session, on its own lightweight daemon, so scheduled agent work keeps firing whether or not you (or an agent) are watching.

## Problem it solves

Agent CLIs are great at *one conversation*. They have no answer for "run this prompt every morning at 9am, forever, even after I close my laptop lid and reopen it next week." crontick is the missing scheduler layer underneath the agent CLI: a schedule plus a prompt, executed by a real engine, with its own history you can inspect later.

## Tenets

| # | Tenet | What this means in practice | Status |
|---|-------|------------------------------|--------|
| 1 | **Session-independent** | Jobs fire whether or not any agent session (or terminal) is open — the daemon does it, not your editor or chat window. The daemon is demand-started (see ADR 0001), not boot-launched: something has to trigger it once, but after that it runs independent of any session. Reboot autostart is intentionally not a goal right now. | Implemented |
| 2 | **Engine-agnostic** | One core lifecycle, many engine adapters. Starts with Claude Code; Copilot, Codex, and others follow the same adapter contract. Users (and the core) should never have to special-case an engine by name. | Partial |
| 3 | **Agent-accessible** | An agent (e.g. Claude Code) can set up and manage its own jobs — create, list, inspect, delete — via the CLI or MCP server, no human required to run the commands. | Implemented |
| 4 | **Session-aware** | crontick creates the engine session itself and knows its identity (session id) and real status — running / finished / failed — not just a process exit code. | Planned / Partial |
| 5 | **Usage-aware** | Follows from session awareness: surface timeouts, token usage, and cost whenever the engine exposes that data. | Partial: Claude runs persist and surface token usage, cost, turns, and engine status (library, CLI, MCP, aggregate stats); other engines expose none yet |
| 6 | **Lightweight** | The daemon and CLI are cheap to run — idle timers, small memory footprint, no heavy dependencies, no polling loops beyond what scheduling needs. The real compute cost is the engine sessions themselves, not crontick. | Implemented |

### Proposed additional tenets — owner to confirm

| # | Tenet | What this means in practice |
|---|-------|------------------------------|
| 7 | **Local-first & private** | No cloud service; all state (jobs, run history, logs) stays on the machine; the daemon speaks loopback-only HTTP, never a remote listener. |
| 8 | **Observable** | Every run is recorded with a status, output, a log of crontick-side events, and session id; nothing fails silently. Missed fires are reported, never silently replayed (see ADR 0001). |
| 9 | **Safe by default** | Secrets are redacted from logs; least-privilege by default; explicit engine permission flags; destructive operations ask for confirmation. |
| 10 | **Recoverable** | Survives daemon restarts — in-flight runs are adopted rather than lost or duplicated, and job definitions are plain files, not opaque state. |
| 11 | **Predictable** | Same input, same behavior, regardless of whether you used the CLI, MCP, or the library — enforced by surface parity. |

## Non-goals

- Not a distributed scheduler — single machine, single user, no clustering or leader election.
- Not a job queue — no external broker, no cross-machine work distribution.
- Not a general command runner — prompt-only; the `script`/`exec` job kinds were removed in the pivot to prompt jobs (ADR 0002).
- Not an OS service manager — crontick does not install a systemd unit, launchd agent, or Windows Service.
- Not a replacement for system cron — it does not run privileged or root-level system tasks.

## How to use this doc

When a design or implementation decision conflicts with a tenet, don't quietly proceed: either change the design to fit the tenet, or update the tenet explicitly here, with an ADR in `docs/decisions/` explaining why. Silence is not agreement — an unresolved conflict between a change and a tenet is a signal to stop and reconcile the two, not to ship around it.
