# crontick

[![CI](https://github.com/tejitpabari99/crontick/actions/workflows/ci.yml/badge.svg)](https://github.com/tejitpabari99/crontick/actions/workflows/ci.yml)
[![Release](https://github.com/tejitpabari99/crontick/actions/workflows/release.yml/badge.svg)](https://github.com/tejitpabari99/crontick/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/crontick)](https://www.npmjs.com/package/crontick)

**crontick** is a standalone cron daemon, CLI, dashboard, client API, and stdio MCP server for
running local scheduled jobs on Windows, macOS, and Linux.

## What ships

- `crontick` — CLI for jobs, daemon control, logs, doctor, dashboard, and MCP launch
- `crontick-daemon` — loopback-only local scheduler + runner + HTTP API
- `crontick-mcp` — stdio MCP server with job, run, schedule, stats, and doctor tools
- `createClient()` — programmatic client/core used by the CLI, MCP server, tests, and embedders
- `plugin/install.mjs` — Copilot plugin installer that installs the package and bundled skill

## v1 scope

- `action.kind: "script"`, `"exec"`, and `"prompt"`
- cron, interval, and one-shot schedules
- stdio MCP transport only
- demand-started daemon for daemon-backed CLI, MCP, and client operations

## Quick start

```sh
npm install -g crontick
crontick new hello --cron "*/5 * * * *" --exec "echo hello"
crontick new prompt-report --cron "0 9 * * *" --prompt "Summarize repo status" -- --silent
crontick list
crontick runs list --limit 10
crontick stats summary
crontick mcp --help
```

Daemon-backed commands demand-start the daemon: if a command needs the scheduler and no healthy
daemon is running, crontick makes one best-effort start/reconnect attempt and retries briefly. This
is **not supervision**: crontick does not install an OS service, keep the daemon alive, or restart it
at the moment it dies. If the daemon exits while idle, scheduled jobs do not run until your next
daemon-backed CLI/MCP/client operation starts it again. Recover with `crontick daemon start`, then
inspect `crontick doctor` and the data-directory `logs/daemon.ensure.log` if startup fails.

Prompt jobs use `--prompt <text>` or `--prompt-file <path.txt>`, optional `--engine <configured-engine>`,
and either `--session-id <id>` or `--reuse-session` for shared context. Explicit `--session-id` wins;
if both are supplied, crontick stores the explicit id and reports that `reuseSession` was ignored.
Arguments after `--` are passed through verbatim to the prompt engine, for example:

```sh
crontick new daily-summary --cron "0 9 * * *" --prompt-file .\summary.txt --engine agency --reuse-session -- --add-dir Q:\Repos\crontick --allow-all-tools
```

Engine startup is configured in `.crontick\config.json`; see
[Configuration](docs/configuration.md).

The public client is the source of truth for behavior. CLI commands and MCP tools are thin adapters
over the same methods, including create/update, run inspection, logs, schedule validation/preview,
stats, doctor, and daemon lifecycle helpers.

## Security model

The daemon API binds only to `127.0.0.1`. There are no bearer tokens or remote listeners; the
trust boundary is the local user session. `exec` and `prompt` actions use `shell=false`, and run
logs are redacted for common secret patterns before they are returned by the API or MCP server.

## Documentation

- [Getting started](docs/getting-started.md)
- [CLI reference](docs/cli.md)
- [MCP usage](docs/mcp.md)
- [Schedules](docs/schedules.md)
- [Actions](docs/actions.md)
- [Configuration](docs/configuration.md)
- [Security](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/architecture.md)
- [Contributing](docs/contributing.md)
- [Releasing](RELEASING.md)

## License

MIT © crontick contributors
