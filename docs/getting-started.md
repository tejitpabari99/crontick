# Getting started

## Prerequisites

- Node.js 22.5 or newer
- npm 10+
- A machine where the daemon can keep local state under `CRONTICK_HOME` or the platform data directory

## Install

```sh
npm install -g crontick
crontick doctor
```

If `npm install` fails with an SSL handshake error, see the [troubleshooting guide](./troubleshooting.md#npm-install-fails).

## Daemon lifecycle

```sh
crontick daemon start
crontick daemon status
```

Most daemon-backed commands demand-start the daemon, so an explicit `daemon start` is optional.
Demand-start means crontick tries one best-effort start/reconnect with a short bounded retry when a
CLI/MCP/client operation needs the daemon and no healthy daemon is reachable.

crontick does **not** supervise or keep alive the daemon. It does not install an OS service, login
item, or watchdog. If the daemon dies while idle, scheduled jobs pause; the next daemon-backed
operation will try to start it again. To recover immediately, run `crontick daemon start`, then
`crontick doctor`. If startup fails, inspect the data-directory `logs/daemon.ensure.log`.

The daemon writes its port and pid files into the crontick data directory and serves the local
dashboard on `127.0.0.1` only.

## Create your first job

```sh
crontick new hello-every-5m --cron "*/5 * * * *" --exec "echo hello"
crontick list
```

PowerShell script example:

```powershell
crontick new cleanup-temp `
  --cron "0 2 * * *" `
  --script "$ErrorActionPreference = 'Stop'; Remove-Item C:\Temp\*.log -Force -ErrorAction SilentlyContinue" `
  --shell pwsh
```

Prompt job example:

```powershell
crontick new daily-summary `
  --cron "0 9 * * *" `
  --prompt "Summarize repository status and mention risky changes" `
  --engine copilot `
  --reuse-session `
  -- --silent --add-dir Q:\Repos\crontick
```

Use `--prompt-file .\prompt.txt` for UTF-8 `.txt` prompts. Everything after `--` is stored as raw
engine arguments.

## View runs and logs

```sh
crontick run-now hello-every-5m
crontick runs list --job hello-every-5m --limit 5
crontick logs <run-id> --tail 50
crontick stats job hello-every-5m
crontick dashboard start --open
crontick dashboard data --runs-limit 10
```


## Copilot plugin / MCP usage

- CLI-hosted MCP: `crontick mcp`
- Copilot plugin installer in this repo/package: `node plugin/install.mjs`

Example MCP host config:

```json
{
  "mcpServers": {
    "crontick": {
      "command": "crontick",
      "args": ["mcp"]
    }
  }
}
```
