# 0004: File-direct config writes, and pause vs stop

- Status: Accepted
- Date: 2026-10-09

## Context

Config editing is being added to the CLI, MCP, library and a dashboard Settings modal. Config is a local file the daemon already reads from disk, but editing it while runs are active raises the question of what should happen to those runs. Daemon pause existed only implicitly.

## Decision

### Config writes are file-direct

CLI, MCP and library `config set|unset` write `config.json` themselves through one core (`applyOps`: lock, re-read, apply on a clone, validate, atomic rename), then best-effort reload a running daemon. They never demand-start a daemon. The dashboard uses `PATCH /api/config`, which runs the same core inside the daemon. Writes are op batches (not whole-object PUT) so the file stays sparse and redacted secrets are never round-tripped; a lock file serializes writers and a content-hash `revision` guards long-lived edit sessions.

### Pause is distinct from stop

`pause` leaves the daemon process, API and dashboard up and only stops the scheduler from starting runs (due fires are recorded `skipped`, not replayed, and not persisted across restart). `stop` exits the process. Saving config with runs in flight requires an explicit choice: stop them, or pause and wait for them to finish, then apply and resume.

## Alternatives considered

- Always write through the daemon API: needs a demand-started daemon and cannot repair a broken setup. Rejected.
- Whole-object PUT: bakes defaults into the file and round-trips redacted secrets. Rejected.
- Replay fires missed during pause, or persist the paused state: surprising bursts on resume and a daemon that stays quiet after restart. Rejected.
- Timeout on waiting for runs: the user can cancel and choose stop instead. Rejected.

## Consequences

- Positive: config is editable with the daemon down; one validation path for all surfaces; no spawn side effects.
- Negative: two writers (CLI and daemon) need the lock; `daemon.port` is editable only with no daemon running; Windows rename-over-open-file behavior needs a manual check. Breaking: the old client config/engine methods and exports are gone.
