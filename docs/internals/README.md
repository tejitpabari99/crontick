# Internals

Implementation details for maintainers and coding agents. Everything here is
subject to change without a major version bump. Do not depend on any internal
described in this directory from outside the crontick repository.

## Index

| Document | Description |
|----------|-------------|
| [core-client.md](core-client.md) | `CrontickClient` class: options, HTTP transport, daemon auto-start, error translation |
| [daemon.md](daemon.md) | Daemon process entry, HTTP server, routes, port discovery, signal handling |
| [scheduler.md](scheduler.md) | Job scheduling via croner: cron/interval/one-shot, tick events, safe timers |
| [executors.md](executors.md) | Runner: script/exec/prompt execution, overlap policy, retry, timeout, log capture |
| [storage.md](storage.md) | SQLite schema, JSON job files, file locations, WAL settings, retention |
| [shims.md](shims.md) | CLI/MCP/library shim wiring, SURFACE_CAPABILITIES, drift test, new-capability checklist |
| [build-and-package.md](build-and-package.md) | tsup config, exports map, dist layout, bin shims, changesets release flow |
