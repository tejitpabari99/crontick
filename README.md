# crontick

**AI-native local cron.** Schedule an AI agent to run on a cron, interval, or one-shot schedule — capture its output and session, observe it in a dashboard — all on one machine, no server.

crontick is a standalone daemon, CLI, and MCP server. Its job kind is a **prompt job**: a natural-language prompt that runs against a configured AI engine. Claude Code is the built-in default.

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

- **AI-first.** Schedule a prompt to run against Claude Code out of the box or another configured CLI engine.
- **Local & single-machine.** A demand-started daemon binds to `127.0.0.1` only. No cloud, no accounts, no remote listeners — the trust boundary is your user session.
- **Three faces, one behavior.** The same operations are available from the **CLI**, a **Node.js library**, and an **MCP server** so a human, a script, or an AI assistant can manage the same jobs.
- **Observable.** Every run records its status, the engine's cleaned output and **session id**, and crontick-side lifecycle events in a per-job log file (the engine keeps its own transcript) — browsable in a built-in **web dashboard**.

Think of it as cron where the thing on a schedule is an **AI agent** instead of a shell script.

---

## Install & requirements

Requires **Node.js >= 22.5** (uses the `node:sqlite` built-in).

```sh
npm install -g crontick     # global, for CLI use
# or run without installing:
npx crontick info
```

The default `claude` engine needs the **Claude Code CLI** on your `PATH`.
You can select another configured engine; see [Engines & configuration](#engines--configuration).

Verify your setup:

```sh
crontick info      # version, runtime, config path, storage paths, daemon status, dashboard URL
crontick doctor    # system health check
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
crontick jobs run-now fern-270     # run once now (works on disabled jobs too; schedule unchanged)
```

Watch what the agent did:

```sh
crontick runs list                 # recent runs across all jobs
crontick runs get <runId>          # status, timing, Runner Session ID, transcript + log file path, then the cleaned output (final answer, error, stderr; no tool calls, thinking or hook noise)
```

Prefer a UI? `crontick info` prints the dashboard URL (by default `http://127.0.0.1:47615/dashboard`; if that port is taken the daemon starts on a free port and says so) where you can browse jobs (with details, search and run-once) in a light or dark theme, runs (multi-select filters, sortable columns, search across run output), and per-run results (final answer, error, stderr, plus the log file and transcript paths with copy buttons).

---

## Scheduling

Every job carries exactly one schedule. Pick the flag that matches:

```sh
# cron expression (fires in the machine's local timezone)
crontick jobs new --cron "0 9 * * *" --prompt "Summarize my open PRs" --alias standup

# fixed interval, in seconds or with an s/m/h/d suffix
crontick jobs new --every 1h --prompt "Check the build and report failures" --alias hourly

# one-shot at a specific ISO-8601 time
crontick jobs new --at "2026-08-01T09:00:00" --prompt "Remind me to cut the release" --alias release-reminder
```

Preview the next fire times for any job:

```sh
crontick jobs schedule standup -n 5
```

Other create/update options: `--timeout <sec>`, `--overlap skip|queue|cancel-previous` (default `skip`), `--retry <max>`, `--force` (replace a job with the same alias). Omitted policy values come from the `defaults` section of `config.json` (`overlap`, `timeoutSec`, `retry`); precedence is CLI flag > per-job JSON > `config.json` > built-in, and the resolved values are saved on the job. When an overlap `skip` job fires while its previous run is still active, the fire is recorded as a `skipped` run (never started), distinct from `canceled`.

---

## Engines & configuration

A **prompt engine** is the AI CLI crontick invokes for a prompt job. crontick ships with a built-in `claude` engine:

```jsonc
{ "command": "claude", "args": [], "env": {}, "type": "claude" }
```

The Claude adapter invokes `claude -p "<your prompt>" --output-format stream-json` with a pre-assigned session ID. A custom engine with no `type` uses the generic raw adapter, which appends the prompt after its configured args. For raw engines that need a prompt-taking flag, put it last in `args`.

### The config file

`crontick info` prints the path to `config.json` (under the data dir). **Edit that file directly.** Engine, logging, and per-run retention changes apply on the next run; `retention.maxRunsPerJob` is read at daemon start, so changing it needs a daemon restart — from the CLI, run `crontick daemon stop` and then any daemon-backed command to start it again.

```jsonc
{
  "defaultEngine": "claude",
  "engines": {
    "claude": { "command": "claude", "args": [], "env": {}, "type": "claude" },
    "custom": { "command": "my-agent", "args": ["--prompt"], "env": {}, "type": "raw" }
  },
  "retention": { "maxRunsPerJob": 100, "maxOutputBytesPerRun": 2000000, "maxLogFiles": 30 },
  "logging": { "fileEnabled": true },
  "defaults": { "overlap": "skip", "retry": { "max": 0, "backoffSec": 30 } }
}
```

Select an engine per job with `--runner`:

```sh
crontick jobs new --every 3600 --prompt "Review recent commits for risky changes" --runner claude --alias review
```

Pass engine options as unknown long flags on `jobs new` or `jobs update`, for example `--permission-mode acceptEdits`. Crontick stores them in the job's `action.args` and forwards them to the engine. It rejects flags it manages itself, including `--output-format` and `--settings`.

### Multi-turn continuity

Prompt jobs can carry an AI session across runs so the agent remembers prior context:

- `--session-id <id>` — reuse a fixed engine session id on every run.
- `--reuse-session` — capture a reusable session after a complete Claude result (including a failed result) or a successful raw-engine run. It requires `--overlap skip`. Claude resumes need the session transcript on disk, otherwise the run fails with `SESSION_NOT_FOUND`.

```sh
crontick jobs new --cron "0 * * * *" --prompt "Continue triaging the incident queue" --reuse-session --alias triage
```

See [docs/reference/configuration.md](docs/reference/configuration.md) for the full schema, environment variables (`CRONTICK_HOME`, `CRONTICK_DAEMON_URL`, `CRONTICK_VERBOSE`), and precedence.

---

## Observing runs

crontick stores only its own logs: lifecycle events (start, timeout, retry, exit) go to one per-job log file, and the cleaned output (final answer, error and stderr) is kept with the run. The engine's raw logs and transcript stay with the engine; crontick does not copy them. `runs get` prints the log file's path and the cleaned output.

```sh
crontick runs list --job standup --status failed
crontick runs get <runId>            # Runner Session ID, log file path and cleaned output; Claude runs also show cost, turns, usage
```

When `logging.fileEnabled` is true (the default), crontick-side events are written to `<logsDir>/<jobGuid>.log` (one file per job, each line tagged with its run id, deleted with the job). Run `crontick info` for the exact `logsDir` and other storage paths, plus the **dashboard URL** — the dashboard offers job/run filters, search, and a per-run output view with a link to the log file. Output is redacted for common secret patterns before storage.

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
  action: { kind: 'prompt', prompt: 'Summarize my open GitHub PRs', engine: 'claude' },
});

console.log('created', job.alias ?? job.id);

const runs = await client.listRuns({ jobId: 'daily-summary' });
console.log(runs.length, 'runs so far');
```

> After daemon-backed calls, prefer setting `process.exitCode = n` and letting Node exit naturally rather than calling `process.exit(n)` immediately.

Full API in [docs/reference/library-api.md](docs/reference/library-api.md); runnable samples in [docs/examples/](docs/examples/).

---

## Command reference at a glance

| Group | Commands |
|-------|----------|
| **jobs** | `new` · `list` · `get` · `update` · `schedule` · `run-now` · `delete` |
| **runs** | `list` · `get` · `cancel` |
| **share** | `export` · `import` |
| **stats** | `summary` · `job` |
| **info** | `info` (version, paths, daemon status, dashboard URL) |
| **doctor** | `doctor` (system health check) |
| **daemon** | `daemon stop` · `daemon reload` |
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

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide (DCO, code style, PR process). For coding agents, see [AGENTS.md](AGENTS.md). For testing, see [docs/testing/testing.md](docs/testing/testing.md).

Validate a change:

```sh
npm run validate    # lint, type-check, tests, and build
```

Report bugs at <https://github.com/tejitpabari99/crontick/issues>.

---

## License

[MIT](LICENSE) — crontick contributors
