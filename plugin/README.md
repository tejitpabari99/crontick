# crontick — Copilot Marketplace Plugin

The `crontick` plugin installs the [crontick](https://www.npmjs.com/package/crontick) npm package and sets up your environment for LLM-assisted local job scheduling via MCP.

## What It Does

1. **Installs `crontick` globally** via `npm install -g crontick` (if not already present)
2. **Runs `crontick doctor`** to verify Node.js, SQLite, and the data directory
3. **Copies `SKILL.md`** to `~/.copilot/skills/crontick/` so Copilot learns to schedule jobs
4. **Optionally installs autostart** (Windows: HKCU Run + VBS shim) so the daemon starts at login

## Manual Installation

```sh
npm install -g crontick
node /path/to/plugin/install.mjs
```

Or non-interactively:

```sh
CRONTICK_PLUGIN_NONINTERACTIVE=1 node plugin/install.mjs
```

## Manual Uninstallation

```sh
node plugin/uninstall.mjs
# Also remove autostart:
CRONTICK_PLUGIN_UNINSTALL_AUTOSTART=1 node plugin/uninstall.mjs
# Also delete all data:
crontick uninstall --purge
```

## Environment Variables

| Variable | Effect |
|----------|--------|
| `CRONTICK_PLUGIN_NONINTERACTIVE=1` | Skip all prompts, accept defaults |
| `CRONTICK_PLUGIN_SKIP_NPM=1` | Skip `npm install -g crontick` (useful for testing) |
| `CRONTICK_PLUGIN_SKIP_AUTOSTART=1` | Skip autostart installation |
| `CRONTICK_PLUGIN_UNINSTALL_AUTOSTART=1` | Remove autostart entry on uninstall |

## After Installation

1. Start the daemon: `crontick daemon start`
2. Schedule a job: `crontick new my-job --cron "0 9 * * *" --script "echo hello"`
3. Configure your MCP host to use `crontick mcp` as an MCP server

See the [README](../README.md) for full documentation.
