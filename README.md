# crontick

[![CI](https://github.com/crontick/crontick/actions/workflows/ci.yml/badge.svg)](https://github.com/crontick/crontick/actions/workflows/ci.yml)
[![Release](https://github.com/crontick/crontick/actions/workflows/release.yml/badge.svg)](https://github.com/crontick/crontick/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/crontick)](https://www.npmjs.com/package/crontick)

**crontick** is a standalone cron daemon, CLI, dashboard, and stdio MCP server for running local
scheduled jobs on Windows, macOS, and Linux.

## What ships

- `crontick` — CLI for jobs, daemon control, logs, doctor, dashboard, and MCP launch
- `crontick-daemon` — loopback-only local scheduler + runner + HTTP API
- `crontick-mcp` — stdio MCP server with job, run, schedule, stats, and doctor tools
- `plugin/install.mjs` — Copilot plugin installer that installs the package, skill, and optional
  Windows autostart

## v1 scope

- `action.kind: "script"` and `action.kind: "exec"`
- cron, interval, and one-shot schedules
- stdio MCP transport only
- Windows autostart via `HKCU\Run`; macOS/Linux provide manual guidance for now

## Quick start

```sh
npm install -g crontick
crontick daemon start
crontick new hello --cron "*/5 * * * *" --exec "echo hello"
crontick list
crontick mcp --help
```

## Security model

The daemon API binds only to `127.0.0.1`. There are no bearer tokens or remote listeners; the
trust boundary is the local user session. `exec` actions always use `shell=false`, and run logs are
redacted for common secret patterns before they are returned by the API or MCP server.

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
