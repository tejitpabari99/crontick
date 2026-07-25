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
- `createClient()` — programmatic client that shares daemon ensure and job validation with the CLI
- `plugin/install.mjs` — Copilot plugin installer that installs the package and bundled skill

## v1 scope

- `action.kind: "script"`, `"exec"`, and `"prompt"`
- cron, interval, and one-shot schedules
- stdio MCP transport only
- on-demand daemon start for daemon-backed CLI, MCP, and client operations

## Quick start

```sh
npm install -g crontick
crontick new hello --cron "*/5 * * * *" --exec "echo hello"
crontick new prompt-report --cron "0 9 * * *" --prompt "Summarize repo status" -- --silent
crontick list
crontick mcp --help
```

Daemon-backed commands start the daemon on demand. Use `crontick daemon start|stop|status` when you
want explicit lifecycle control.

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
- [Security](docs/security.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/architecture.md)
- [Contributing](docs/contributing.md)
- [Releasing](RELEASING.md)

## License

MIT © crontick contributors
