# crontick

A standalone cron daemon, CLI, and MCP server for local scheduled jobs.

crontick lets you define periodic and one-shot jobs (shell scripts, direct commands, or LLM
prompt invocations) and manage them identically from a terminal, a Node.js program, or an
AI agent over MCP. A demand-started daemon handles scheduling and execution; three thin shims
(CLI, library client, stdio MCP server) expose the same 37 capabilities with no drift.

### Documentation

| Resource | Path |
|----------|------|
| Documentation hub | [docs/README.md](docs/README.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) |
| Reference (API, CLI, MCP, schemas) | [docs/reference/](docs/reference/) |
| Testing guide | [docs/testing.md](docs/testing.md) |
| Runnable examples | [examples/](examples/) |
| Behavior specs | [specs/](specs/) |
| Design decisions (ADRs) | [docs/decisions/](docs/decisions/) |

---

## Why this package exists

System schedulers (cron, Windows Task Scheduler) are not portable, not programmatically
controllable from the same process, and invisible to AI agents. In-process libraries
(node-cron, node-schedule) disappear when the process exits and cannot be inspected from a
separate tool.

crontick fills the gap: a user-space scheduler that persists jobs across reboots (via a
demand-started daemon), supports cron expressions, fixed intervals, and one-shot schedules,
and is accessible from three equivalent surfaces so a human, a script, and an LLM tool-caller
can all manage the same job set.

---

## Installation

Requires **Node.js >= 22.5** (uses `node:sqlite` built-in).

```sh
# Global install for CLI use
npm install -g crontick

# Local install for library/programmatic use
npm install crontick
```

---

## Quick start

### CLI

```sh
npm install -g crontick
crontick new hello --cron "*/5 * * * *" --exec node --arg -e --arg "console.log('hello')"
crontick list
crontick daemon status
```

> `--arg <value>` (repeatable) is the primary, always-correct way to pass arguments to `--exec`/
> `--prompt` -- it works identically on every shell and every Windows shim (`crontick.cmd`,
> `crontick.ps1`, `npx crontick`) and round-trips spaces, quotes, and leading dashes verbatim. See
> [CLI reference](docs/reference/cli.md#windows-shells---arg-vs---) for the full behavior matrix,
> including why the `--` convenience form is unreliable on `crontick.ps1`.
>
> Create is no longer an upsert: reusing an existing job id with `crontick new` or `createJob()`
> now fails with `JOB_ALREADY_EXISTS`. Use `crontick update <id>` to mutate an existing job, or
> pass `--force` / `force: true` when you intentionally want replacement.

### Library (ESM)

```ts
import { createClient } from 'crontick';

const client = createClient();

await client.createJob({
  id: 'hello-interval',
  schedule: { kind: 'interval', everySec: 60 },
  action: { kind: 'script', script: 'echo "hello from crontick"' },
});

const jobs = await client.listJobs();
console.log(jobs.map(j => j.id));
```

---

## Common use cases

### Periodic script

```sh
crontick new backup --cron "0 2 * * *" --script "pg_dump mydb > /backups/db.sql"
```

### One-shot reminder

```sh
crontick new deploy-reminder --at "2026-08-01T09:00:00" --exec notify-send --arg "Deploy v2 today"
```

`--exec <command>` takes the command verbatim (no whitespace splitting); repeatable `--arg
<value>` builds its argument list one value at a time, so `"Deploy v2 today"` reaches
`notify-send` as one argument, spaces included -- and this round-trips correctly on every shell
and every Windows shim (`crontick.cmd`, `crontick.ps1`, `npx crontick`). Need shell features
(pipes, redirects, globbing) instead? Use `--script`, which runs through a shell.

> As a convenience, args may instead follow a literal `--` (`--exec notify-send -- "Deploy v2
> today"`), but this is not reliable on every shim: PowerShell's own parameter binding drops a
> literal `--` token before `crontick.ps1` ever sees it (true for any `.ps1` script, not specific
> to crontick), so a `--exec`/`--` command silently loses its trailing args there. `--arg` has no
> such gap -- see [CLI reference](docs/reference/cli.md#windows-shells---arg-vs---) for the full matrix.

### Execute a binary directly

```sh
crontick new healthcheck --every 30 --exec curl --arg -sf --arg http://localhost:3000/health
```

### AI prompt job

```sh
crontick new daily-summary --cron "0 9 * * *" --prompt "Summarize yesterday's git log" --engine copilot
```

### Wire into an MCP client

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "crontick": { "command": "crontick-mcp" }
  }
}
```

The MCP server exposes all 37 capabilities as tools (e.g., `crontick_job_create`,
`crontick_job_list`, `crontick_schedule_preview`).

---

## API

The public API boundary is defined by `package.json#exports`:

```json
{ ".": "./dist/index.js", "./package.json": "./package.json" }
```

The library entry point (`import ... from 'crontick'`) exports:

| Export | Purpose |
|--------|---------|
| `createClient` / `CrontickClient` | Programmatic access to all 37 capabilities |
| `CrontickError` | Typed error with `code`, `message`, `details` |
| `ORPHAN_RUN_ERROR_CODE` / `ORPHAN_RUN_ERROR_MESSAGE` | Stored `runs.error` value/prefix for a run canceled by a daemon restart (not a thrown `CrontickError` code) |
| `SURFACE_CAPABILITIES` | Registry of all capability names, client methods, CLI commands, and MCP tool names |
| `JobSchema`, `ScheduleSchema`, `PromptActionSchema` | Zod schemas for validation |
| `RetentionConfigSchema` / `RetentionConfig` | Run retention config schema/type (`maxRunsPerJob`, `maxOutputBytesPerRun`, `maxLogFiles`) |
| `jobJsonSchema` / `jobJsonSchemaText` | JSON Schema representation of a job |
| Config utilities | `loadConfig`, `initConfig`, `getConfigValue`, `setConfigValue`, etc. |
| Logger utilities | `createLogger`, `nullLogger`, `redactText` |

Full reference:

- [Library API](docs/reference/library-api.md)
- [CLI reference](docs/reference/cli.md)
- [MCP tools](docs/reference/mcp-tools.md)
- [Job schema](docs/reference/job-schema.md)

---

## Configuration

State and configuration live in a platform-specific data directory:

| OS | Default path |
|----|-------------|
| Windows | `%LOCALAPPDATA%\crontick\` |
| macOS | `~/Library/Application Support/crontick/` |
| Linux | `~/.local/share/crontick/` |

Override with `CRONTICK_HOME`.

Key environment variables: `CRONTICK_HOME`, `CRONTICK_DAEMON_URL`, `CRONTICK_VERBOSE`.

Each job retains at most `retention.maxRunsPerJob` runs (default `100`, range `1..100000`);
older terminal runs and their logs are pruned automatically, and a changed cap takes effect on
`crontick daemon reload` without a restart. `retention.maxOutputBytesPerRun` (default `2_000_000`,
range `1024..1_000_000_000`) caps captured stdout/stderr per run -- once hit, output is truncated
at a UTF-8 character boundary and the run's `outputTruncated` field is set.
`retention.maxLogFiles` (default `30`, range `1..3650`) similarly bounds how many daily daemon
log files are kept. Back up run history before it's pruned with `crontick export --include-runs`
(see [docs/reference/cli.md](docs/reference/cli.md)). These are per-job/per-run/log-file caps
only -- see
[docs/concepts/state-and-storage.md](docs/concepts/state-and-storage.md#run-history-retention)
for the exact behavior and its design boundaries.

See [docs/reference/configuration.md](docs/reference/configuration.md) for the full config
file schema, all environment variables, and precedence rules.

---

## Error handling

All surfaces raise or return `CrontickError` with a machine-readable `code`:

```ts
import { createClient, CrontickError } from 'crontick';
const client = createClient();
try {
  await client.getJob('nonexistent');
} catch (err) {
  if (err instanceof CrontickError) console.error(err.code, err.message);
}
```

- **CLI**: prints `Error [<code>]: <message>` to stderr; exits non-zero.
- **MCP**: returns `isError: true` with `{ code, message, details }` in tool result content.
- **Library**: throws `CrontickError` directly.

See [docs/reference/errors.md](docs/reference/errors.md) for all error codes and their triggers.

---

## Runtime compatibility

| Requirement | Value |
|-------------|-------|
| Node.js | >= 22.5 (uses `node:sqlite` built-in) |
| OS | Windows, macOS, Linux |
| Module system | ESM only (`"type": "module"`) |
| CJS import | Not supported; use dynamic `import()` from CJS if needed |
| TypeScript | Full `.d.ts` declarations shipped |

---

## Migration and breaking changes

crontick uses [changesets](https://github.com/changesets/changesets) for versioning and
follows semver strictly. On-disk state format compatibility is covered by
[specs/006-state-and-persistence.md](specs/006-state-and-persistence.md).

The pending 1.0.0 release consumes the changesets in `.changeset/`; see them for the
behavior it introduces. One breaking change already queued there: creating a job is no
longer a silent upsert. A duplicate id now fails with `JOB_ALREADY_EXISTS` unless you
pass explicit overwrite intent (`--force` on the CLI, `force: true` in library/MCP);
invalid schedules are rejected before any existing job can be replaced.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide (DCO, code style, PR
process). For coding agents, see [AGENTS.md](AGENTS.md). For testing instructions,
see [docs/testing.md](docs/testing.md).

Report bugs at <https://github.com/tejitpabari99/crontick/issues>.

Validate a change:

```sh
npm run validate
```

This runs lint, type-check, tests, and build in sequence.

---

## Security

The daemon listens on `127.0.0.1` only. There are no authentication tokens or remote
listeners; the trust boundary is the local user session.

Job definitions are trusted input by design: the purpose of the tool is to execute arbitrary
commands on a schedule. `exec` and `prompt` actions use `shell=false`; `script` actions
execute through an explicit shell. Run logs are redacted for common secret patterns before
storage or return.

To report a vulnerability, open a private security advisory at
<https://github.com/tejitpabari99/crontick/security/advisories/new>.

See [SECURITY.md](SECURITY.md) for the full security model.

---

## License

[MIT](LICENSE) - crontick contributors
