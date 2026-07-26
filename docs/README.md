# Documentation

This directory contains all crontick documentation, organized by audience and purpose.
Each area has a distinct role; consult the table below to find what you need or to decide
where new content belongs.

---

## Areas

| Area | Answers | Audience |
|------|---------|----------|
| [docs/architecture.md](architecture.md) | High-level design: how the system fits together | Everyone |
| [docs/concepts/](concepts/) | "How should I think about this?" -- behavior that crosses components | Users and contributors |
| [docs/internals/](internals/) | "How is this implemented?" -- private implementation details | Maintainers and coding agents |
| [docs/reference/](reference/) | "What exactly is supported?" -- precise, lookup-oriented facts | Users |
| [docs/decisions/](decisions/) | "Why is it like this?" -- architecture decision records | Contributors |
| [docs/testing.md](testing.md) | How to test and what to verify before a release | Contributors |
| [specs/](../specs/) | Normative behavior contracts with acceptance criteria | Contributors and coding agents |
| [examples/](../examples/) | Runnable public-API usage examples | Users |

---

## Where do I put new documentation?

- **A user-visible fact** (command syntax, config option, error code) -> `docs/reference/`
- **A mental model** (how scheduling works, job lifecycle, surface parity) -> `docs/concepts/`
- **An implementation detail** (how the scheduler loop works, storage format internals) -> `docs/internals/`
- **A design choice with trade-offs** -> a new ADR in `docs/decisions/` (copy `0000-template.md`)
- **A behavior contract with acceptance criteria** -> a new spec in `specs/`
- **A runnable code sample** -> `examples/`

---

## Rule

Documentation is updated in the same change as the behavior it describes. A PR that changes
observable behavior without updating relevant docs is incomplete.

---

## Full index

### docs/ (top-level)

| File | Description |
|------|-------------|
| [architecture.md](architecture.md) | System architecture: daemon, client, shims, state, IPC |
| [testing.md](testing.md) | Test layers, running tests, pre-release checklist |
| [troubleshooting.md](troubleshooting.md) | Common issues and diagnostics |

### docs/concepts/

| File | Description |
|------|-------------|
| [jobs.md](concepts/jobs.md) | What a job is: identity, lifecycle, enabled/disabled semantics |
| [scheduling.md](concepts/scheduling.md) | Cron, interval, and one-shot schedule behavior |
| [execution.md](concepts/execution.md) | How actions run: shell rules, timeouts, cancellation |
| [daemon-lifecycle.md](concepts/daemon-lifecycle.md) | Demand-start, shutdown, no supervision |
| [state-and-storage.md](concepts/state-and-storage.md) | Where state lives, SQLite WAL, JSON files |
| [surface-parity.md](concepts/surface-parity.md) | The 36-capability contract across CLI/MCP/library |
| [error-model.md](concepts/error-model.md) | Error codes, structured errors, surface presentation |

### docs/internals/

| File | Description |
|------|-------------|
| [README.md](internals/README.md) | Internals overview and reading order |
| [core-client.md](internals/core-client.md) | CrontickClient implementation details |
| [daemon.md](internals/daemon.md) | Daemon process: HTTP server, routing, lifecycle |
| [scheduler.md](internals/scheduler.md) | Scheduler loop: croner integration, tick behavior |
| [executors.md](internals/executors.md) | Script, exec, and prompt executor implementations |
| [storage.md](internals/storage.md) | SQLite schema, WAL mode, migrations |
| [shims.md](internals/shims.md) | CLI and MCP shim architecture (thin adapters) |
| [build-and-package.md](internals/build-and-package.md) | tsup config, bin entries, publish pipeline |

### docs/reference/

| File | Description |
|------|-------------|
| [README.md](reference/README.md) | Reference section overview |
| [cli.md](reference/cli.md) | Complete CLI command reference |
| [mcp-tools.md](reference/mcp-tools.md) | All MCP tool names, parameters, and return shapes |
| [library-api.md](reference/library-api.md) | Exported functions, classes, types, and their signatures |
| [job-schema.md](reference/job-schema.md) | Full job JSON schema with all fields |
| [configuration.md](reference/configuration.md) | Config file schema, env vars, precedence |
| [errors.md](reference/errors.md) | All error codes, triggers, and surface-specific behavior |
| [glossary.md](reference/glossary.md) | Term definitions used across the docs |

### docs/decisions/

| File | Description |
|------|-------------|
| [README.md](decisions/README.md) | ADR index and process |
| [0000-template.md](decisions/0000-template.md) | Template for new ADRs |

See [decisions/README.md](decisions/README.md) for the full list of architecture decision records (ADRs 0001-0013).

### specs/

| File | Description |
|------|-------------|
| [README.md](../specs/README.md) | Specs overview and conventions |
| [TEMPLATE.md](../specs/TEMPLATE.md) | Template for new specs |
| [001-job-definition.md](../specs/001-job-definition.md) | Job definition schema and semantics |
| [002-scheduling.md](../specs/002-scheduling.md) | Scheduling behavior contract |
| [003-execution.md](../specs/003-execution.md) | Execution guarantees and failure modes |
| [004-daemon.md](../specs/004-daemon.md) | Daemon process lifecycle contract |
| [005-surface-parity.md](../specs/005-surface-parity.md) | Surface parity requirements |
| [006-state-and-persistence.md](../specs/006-state-and-persistence.md) | State format and migration guarantees |
| [007-prompt-jobs.md](../specs/007-prompt-jobs.md) | Prompt job behavior specification |

### examples/

| File | Description |
|------|-------------|
| [README.md](../examples/README.md) | Examples overview and how to run them |
| [01-quick-start.ts](../examples/01-quick-start.ts) | Create, list, and delete a job |
| [02-cron-schedule.ts](../examples/02-cron-schedule.ts) | Cron-scheduled job |
| [03-exec-job.ts](../examples/03-exec-job.ts) | Direct command execution job |
| [04-prompt-job.ts](../examples/04-prompt-job.ts) | LLM prompt job |
| [05-one-shot.ts](../examples/05-one-shot.ts) | One-shot scheduled job |
| [06-run-history.ts](../examples/06-run-history.ts) | Querying run history and logs |
| [07-lifecycle.ts](../examples/07-lifecycle.ts) | Daemon lifecycle management |
| [cli/README.md](../examples/cli/README.md) | CLI usage examples |
| [mcp/README.md](../examples/mcp/README.md) | MCP integration examples |
