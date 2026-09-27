# crontick

**AI-native local cron.** Schedule an AI agent to run on a cron, interval, or one-shot schedule — capture its output and session, observe it in a dashboard — all on one machine, no server.

crontick is a standalone daemon, CLI, and MCP server. Its primary job kind is a **prompt job**: a natural-language prompt that runs against an AI engine (GitHub Copilot CLI by default, `copilot --allow-all-tools -p "<prompt>"`). Classic script/exec jobs still exist in the core for advanced use, but the happy path is scheduling AI.

### Documentation

| Resource | Path |
|----------|------|
| Documentation hub | [docs/README.md](docs/README.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) |
| Concepts | [docs/concepts/](docs/concepts/) |
| Reference (API, CLI, MCP, schemas) | [docs/reference/](docs/reference/) |
| Runnable examples | [docs/examples/](docs/examples/) |
| Design decisions (ADRs) | [docs/decisions/](docs/decisions/) |

---

## What is crontick?

- **AI-first.** The default job is a **prompt job** — schedule a prompt to run against an AI engine (Copilot CLI out of the box) and let it use its tools autonomously.
- **Local & single-machine.** A demand-started daemon binds to `127.0.0.1` only. No cloud, no accounts, no remote listeners — the trust boundary is your user session.
- **Three faces, one behavior.** The same operations are available from the **CLI**, a **Node.js library**, and an **MCP server** so a human, a script, or an AI assistant can manage the same jobs.
- **Observable.** Every run captures engine stdout/stderr, crontick-side lifecycle events, the engine **session id**, and a per-job log file — browsable in a built-in **web dashboard**.
- **Advanced escape hatch.** Shell `script` and direct `exec` jobs remain first-class in the schema, daemon, and library; they're just intentionally not exposed as CLI convenience flags. Create them with `jobs new --file <job.json>` or the library.

Think of it as cron where the thing on a schedule is an **AI agent** instead of a shell script.

---

## Install & requirements

Requires **Node.js >= 22.5** (uses the `node:sqlite` built-in).

```sh
npm install -g crontick     # global, for CLI use
# or run without installing:
npx crontick info
```

The default `copilot` engine needs the **GitHub Copilot CLI** on your `PATH`. Install it from
[github/copilot-cli](https://github.com/github/copilot-cli) (or point crontick at a different engine — see [Engines & configuration](#engines--configuration)).

Verify your setup:

```sh
crontick info      # version, runtime, config path, storage paths, daemon status, dashboard URL
crontick info doctor    # system health check
```

---

## Quick start — an AI job in 60 seconds

Schedule an AI agent to summarize your open PRs every morning at 9:00. The prompt is passed with `--prompt`, and an `alias` is generated automatically (no id to manage):

```sh
crontick jobs new --desc "daily standup" --cron "0 9 * * *" --prompt "Summarize my open GitHub PRs"
```

crontick prints the new job, including its auto-assigned `alias` (e.g. `fern-270`). Use that alias everywhere:

```sh
crontick jobs list                 # see all jobs
crontick jobs get fern-270         # inspect one job
crontick jobs run-now fern-270     # trigger an immediate run
```

Watch what the agent did:

```sh
crontick runs list                 # recent runs across all jobs
crontick runs get <runId>          # resolved command, status, timing, session id
crontick runs logs <runId>         # both streams; add "engine" or "crontick" to filter
crontick runs logs <runId> engine  # just the AI engine's stdout/stderr
```

Prefer a UI? `crontick info` prints the dashboard URL (`http://127.0.0.1:<port>/dashboard`) where you can browse jobs, runs, and per-run logs.

---

## Scheduling

Every job carries exactly one schedule. Pick the flag that matches:

```sh
# cron expression (optionally with --tz)
crontick jobs new --cron "0 9 * * *" --prompt "Summarize my open PRs" --alias standup

# fixed interval, in seconds
crontick jobs new --every 3600 --prompt "Check the build and report failures" --alias hourly

# one-shot at a specific ISO-8601 time
crontick jobs new --at "2026-08-01T09:00:00" --prompt "Remind me to cut the release" --alias release-reminder
```

Preview the next fire times for any job:

```sh
crontick jobs schedule standup -n 5
```

Other create/update options: `--timeout <sec>`, `--overlap skip|queue|cancel-previous` (default `skip`), `--retry <max>`, `--force` (replace a job with the same alias).

---

## Engines & configuration

A **prompt engine** is the AI CLI crontick invokes for a prompt job. crontick ships with a built-in `copilot` engine:

```jsonc
{ "command": "copilot", "args": ["--allow-all-tools", "-p"], "env": {} }
```

At run time crontick appends the prompt after the engine args, producing `copilot --allow-all-tools -p "<your prompt>"`. If you customize `args`, keep the prompt-taking flag (`-p`) **last** — crontick puts the prompt text immediately after it.

### The config file

`crontick info` prints the path to `config.json` (under the data dir). **Edit that file directly.** Engine, logging, and per-run retention changes apply on the next run; `retention.maxRunsPerJob` is read at daemon start, so changing it needs a daemon restart — from the CLI, run `crontick info daemon stop` and then any daemon-backed command to start it again.

```jsonc
{
  "defaultEngine": "copilot",
  "engines": {
    "copilot": { "command": "copilot", "args": ["--allow-all-tools", "-p"], "env": {} },
    "claude":  { "command": "claude",  "args": ["-p"], "env": { "ANTHROPIC_API_KEY": "..." } }
  },
  "retention": { "maxRunsPerJob": 100, "maxOutputBytesPerRun": 2000000, "maxLogFiles": 30 },
  "logging": { "fileEnabled": true }
}
```

Select an engine per job with `--engine`:

```sh
crontick jobs new --every 3600 --prompt "Review recent commits for risky changes" --engine claude --alias review
```

### Multi-turn continuity

Prompt jobs can carry an AI session across runs so the agent remembers prior context:

- `--session-id <id>` — reuse a fixed engine session id on every run.
- `--reuse-session` — capture the session id from the first successful run and reuse it thereafter.

```sh
crontick jobs new --cron "0 * * * *" --prompt "Continue triaging the incident queue" --reuse-session --alias triage
```

See [docs/reference/configuration.md](docs/reference/configuration.md) for the full schema, environment variables (`CRONTICK_HOME`, `CRONTICK_DAEMON_URL`, `CRONTICK_VERBOSE`), and precedence.

---

## Observing runs

Each run records two log streams and a per-job log file:

- **engine** — the AI engine's stdout + stderr (what the agent produced).
- **crontick** — scheduling/execution lifecycle events (start, timeout, retry, exit).

```sh
crontick runs list --job standup --status failed
crontick runs get <runId>            # includes the captured engine session id
crontick runs logs <runId>           # both streams
crontick runs logs <runId> crontick  # lifecycle events only
```

When `logging.fileEnabled` is true (the default), every run is also mirrored to `<logsDir>/<jobGuid>.log`. Run `crontick info` for the exact `logsDir` and other storage paths, plus the **dashboard URL** — the dashboard offers job/run filters and a per-run log modal. Output is redacted for common secret patterns before storage.

---

## Use from an AI assistant (MCP)

crontick ships an MCP server so an AI assistant can manage schedules for you. The tools mirror the CLI one-to-one (prefix `crontick_`).

Start it with `crontick mcp` (or the `crontick-mcp` bin) over stdio, and wire it into your MCP host — Copilot, Claude Desktop, Cursor, etc.:

```json
{
  "mcpServers": {
    "crontick": { "command": "crontick", "args": ["mcp"] }
  }
}
```

See [docs/reference/mcp-tools.md](docs/reference/mcp-tools.md) for the full tool list.

---

## Use as a library

```ts
import { createClient } from 'crontick';

const client = createClient();

// Schedule an AI prompt job.
const job = await client.createJob({
  alias: 'daily-summary',
  schedule: { kind: 'cron', cron: '0 9 * * *' },
  action: { kind: 'prompt', prompt: 'Summarize my open GitHub PRs', engine: 'copilot' },
});

console.log('created', job.alias ?? job.id);

const runs = await client.listRuns({ jobId: 'daily-summary' });
console.log(runs.length, 'runs so far');
```

> After daemon-backed calls, prefer setting `process.exitCode = n` and letting Node exit naturally rather than calling `process.exit(n)` immediately.

Full API in [docs/reference/library-api.md](docs/reference/library-api.md); runnable samples in [docs/examples/](docs/examples/).

---

## Advanced: script & exec jobs via `--file`

Shell `script` and direct `exec` actions are fully supported by the schema, daemon, and library — they're just not exposed as CLI convenience flags. Create them from a full job-definition JSON file, or with the library:

```json
{
  "alias": "backup",
  "schedule": { "kind": "cron", "cron": "0 2 * * *" },
  "action": { "kind": "script", "script": "pg_dump mydb > /backups/db.sql" }
}
```

```sh
crontick jobs new --file .\backup-job.json
```

See [docs/reference/job-schema.md](docs/reference/job-schema.md) for all action kinds and fields.

---

## Command reference at a glance

| Group | Commands |
|-------|----------|
| **jobs** | `new` · `list` · `get` · `update` · `schedule` · `run-now` · `delete` |
| **runs** | `list` · `get` · `logs` · `cancel` · `delete` |
| **share** | `export` · `import` |
| **stats** | `summary` · `job` |
| **info** | `info` (version, paths, daemon status, dashboard URL) |
| **doctor** | `info doctor` (system health check) |
| **daemon** | `info daemon stop` · `info daemon reload` |
| **mcp** | `mcp` (start the MCP server on stdio) |

Full CLI reference: [docs/reference/cli.md](docs/reference/cli.md).

---

## Storage locations

State and configuration live in a platform-specific data directory (override with `CRONTICK_HOME`):

| OS | Default path |
|----|--------------|
| Windows | `%LOCALAPPDATA%\crontick\` |
| macOS | `~/Library/Application Support/crontick/` |
| Linux | `~/.local/share/crontick/` |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide (DCO, code style, PR process). For coding agents, see [AGENTS.md](AGENTS.md). For testing, see [docs/testing.md](docs/testing.md).

Validate a change:

```sh
npm run validate    # lint, type-check, tests, and build
```

Report bugs at <https://github.com/tejitpabari99/crontick/issues>.

---

## License

[MIT](LICENSE) — crontick contributors
