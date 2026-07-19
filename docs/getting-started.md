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

## Start the daemon

```sh
crontick daemon start
crontick daemon status
```

The daemon writes its port and pid files into the crontick data directory and serves the local dashboard on `127.0.0.1` only.

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

## View runs and logs

```sh
crontick run-now hello-every-5m
crontick logs <run-id> --tail 50
crontick dashboard
```

## Windows autostart

v1 supports managed autostart on Windows via `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` and a generated hidden VBS shim.

```powershell
crontick autostart install
crontick autostart status
```

On macOS and Linux, `crontick autostart status` and the API return manual instructions for now.

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

See [mcp.md](mcp.md) for tools, resources, prompts, and autostart behavior.
