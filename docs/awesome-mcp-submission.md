# Draft PR body for awesome-mcp-servers

## Title

Add crontick — local cron daemon + scheduler MCP server

## Summary

`crontick` is an open-source stdio MCP server backed by a local cron daemon. It lets MCP-capable clients create, validate, preview, run, inspect, and troubleshoot scheduled local jobs.

## Why it fits

- practical automation use case: recurring and one-shot local jobs
- safe local-first design: loopback daemon, stdio MCP, shell=false exec support
- rich operational surface: jobs, runs, logs, stats, doctor, dashboard, autostart
- bundled skill/docs for Copilot- and Claude-style hosts

## Repository / package

- Repo: `https://github.com/tejitpabari99/crontick`
- npm: `https://www.npmjs.com/package/crontick`

## Quick config snippet

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

## Categories

- Automation
- Developer tools
- Productivity
