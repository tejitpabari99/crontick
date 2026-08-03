# crontick

A standalone cron daemon, CLI, and MCP server for local scheduled jobs.

crontick lets you define periodic and one-shot jobs (shell scripts, direct commands, or LLM prompt invocations) and manage them from a terminal, a Node.js program, or an AI agent over MCP. A demand-started daemon handles scheduling and execution; three thin shims (CLI, library client, stdio MCP server) expose the same 26 parity capabilities with no drift.

### Documentation

| Resource | Path |
|----------|------|
| Documentation hub | [docs/README.md](docs/README.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) |
| Reference (API, CLI, MCP, schemas) | [docs/reference/](docs/reference/) |
| Testing guide | [docs/testing.md](docs/testing.md) |
| Runnable examples | [docs/examples/](docs/examples/) |
| Behavior specs | [docs/specs/](docs/specs/) |
| Design decisions (ADRs) | [docs/decisions/](docs/decisions/) |

---

## Why this package exists

System schedulers (cron, Windows Task Scheduler) are not portable, not programmatically controllable from the same process, and invisible to AI agents. In-process libraries (node-cron, node-schedule) disappear when the process exits and cannot be inspected from a separate tool.

crontick fills the gap: a user-space scheduler that persists jobs across reboots (via a demand-started daemon), supports cron expressions, fixed intervals, and one-shot schedules, and is accessible from equivalent surfaces so a human, a script, and an LLM tool-caller can all manage the same job set.

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
crontick jobs new --every 300 --prompt "Say hello from crontick" --alias hello
crontick jobs list
crontick jobs schedule hello -n 5
crontick runs list --job hello
crontick info
crontick config
```

`crontick config` prints the config file path. Edit that file by hand; most edits apply on the next run, while `retention.maxRunsPerJob` requires `crontick daemon restart`.

Script and exec actions remain supported in the job schema, daemon, and library. The CLI no longer has dedicated `--script` or `--exec` flags; create those jobs with a full JSON definition:

```sh
crontick jobs new --file .\job.json
```

### Library (ESM)

```ts
import { createClient } from 'crontick';

const client = createClient();

await client.createJob({
  alias: 'hello-interval',
  schedule: { kind: 'interval', everySec: 60 },
  action: { kind: 'script', script: 'echo "hello from crontick"' },
});

const jobs = await client.listJobs();
console.log(jobs.map(j => j.alias ?? j.id));
```

> Library exit guidance: after daemon-backed calls, prefer `process.exitCode = n` and let Node exit naturally instead of calling `process.exit(n)` immediately.

---

## Common use cases

### Periodic script from the CLI

Create `backup-job.json`:

```json
{
  "alias": "backup",
  "schedule": { "kind": "cron", "cron": "0 2 * * *" },
  "action": { "kind": "script", "script": "pg_dump mydb > /backups/db.sql" }
}
```

Then import it:

```sh
crontick jobs new --file .\backup-job.json
```

### One-shot prompt reminder

```sh
crontick jobs new --at "2026-08-01T09:00:00" --prompt "Remind me to deploy v2" --alias deploy-reminder
```

### Execute a binary directly from the library

```ts
await client.createJob({
  alias: 'healthcheck',
  schedule: { kind: 'interval', everySec: 30 },
  action: { kind: 'exec', command: 'curl', args: ['-sf', 'http://localhost:3000/health'] },
});
```

### AI prompt job

```sh
crontick jobs new --cron "0 9 * * *" --prompt "Summarize yesterday's git log" --engine copilot --alias daily-summary
```

The built-in `copilot` engine is preconfigured for unattended prompt jobs with `--allow-all-tools -p`. If you override `engines.copilot.args`, keep the prompt-taking flag (`-p` / `--prompt`) last because crontick appends the prompt text immediately after the configured engine args.

### Wire into an MCP client

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "crontick": { "command": "crontick", "args": ["mcp"] }
  }
}
```

The MCP server exposes all 26 parity capabilities as tools, including `crontick_job_create`, `crontick_job_schedule`, `crontick_run_delete`, `crontick_config_path`, and `crontick_info`.

---

## API

The public API boundary is defined by `package.json#exports`:

```json
{ ".": "./dist/index.js", "./package.json": "./package.json" }
```

The library entry point (`import ... from 'crontick'`) exports:

| Export | Purpose |
|--------|---------|
| `createClient` / `CrontickClient` | Programmatic access to crontick operations |
| `CrontickError` | Typed error with `code`, `message`, `details` |
| `ORPHAN_RUN_ERROR_CODE` / `ORPHAN_RUN_ERROR_MESSAGE` | Stored `runs.error` value/prefix for a run canceled by a daemon restart (not a thrown `CrontickError` code) |
| `SURFACE_CAPABILITIES` | Registry of capability names, client methods, CLI commands, and MCP tool names |
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
|----|--------------|
| Windows | `%LOCALAPPDATA%\crontick\` |
| macOS | `~/Library/Application Support/crontick/` |
| Linux | `~/.local/share/crontick/` |

Override with `CRONTICK_HOME`.

Key environment variables: `CRONTICK_HOME`, `CRONTICK_DAEMON_URL`, `CRONTICK_VERBOSE`.

Find the config file with:

```sh
crontick config
```

Most config edits apply automatically on the next run: engine definitions, prompt command resolution, logging, and `retention.maxOutputBytesPerRun`. `retention.maxRunsPerJob` is cached by the daemon Store at startup, so changing it requires `crontick daemon restart`.

Back up run history before it is pruned with `crontick share export --include-runs`.

See [docs/reference/configuration.md](docs/reference/configuration.md) for the full config file schema, all environment variables, and precedence rules.

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

- **CLI**: prints `error: [CODE] message` (or `error: message`) to stderr in red when supported; exits non-zero. `--verbose` adds details and stack output.
- **MCP**: returns `isError: true` with `{ error: "..." }` in tool result content.
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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide (DCO, code style, PR process). For coding agents, see [AGENTS.md](AGENTS.md). For testing instructions, see [docs/testing.md](docs/testing.md).

Report bugs at <https://github.com/tejitpabari99/crontick/issues>.

Validate a change:

```sh
npm run validate
```

This runs lint, type-check, tests, and build in sequence.

---

## Security

The daemon listens on `127.0.0.1` only. There are no authentication tokens or remote listeners; the trust boundary is the local user session.

Job definitions are trusted input by design: the purpose of the tool is to execute arbitrary commands on a schedule. `exec` and `prompt` actions use `shell=false`; `script` actions execute through an explicit shell. Run logs are redacted for common secret patterns before storage or return.

To report a vulnerability, open a private security advisory at <https://github.com/tejitpabari99/crontick/security/advisories/new>.

See [SECURITY.md](SECURITY.md) for the full security model.

---

## License

[MIT](LICENSE) - crontick contributors
