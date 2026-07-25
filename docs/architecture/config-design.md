# crontick config design

## Goals

- Keep configuration owned by core: schema, defaults, file I/O, validation, merging, and mutation.
- Keep CLI, MCP, and public client as thin adapters over the same core/client methods.
- Start with engine startup config only; leave future settings out until they are needed.
- Preserve no-config behavior: prompt jobs run through `copilot` by default.

## File and schema

Config lives at the existing crontick state root: `.crontick\config.json` when
`CRONTICK_HOME=.crontick`, otherwise `<dataDir>\config.json` from `configPath()`.

```json
{
  "defaultEngine": "copilot",
  "engines": {
    "copilot": {
      "command": "copilot",
      "args": ["-p"],
      "env": {}
    }
  }
}
```

Minimal rules:

- `defaultEngine` is required in the effective config and must name an engine.
- `engines` is a non-empty object keyed by simple engine ids: `a-z`, `0-9`, `_`, `-`, `.`.
- Each engine has a non-empty `command`, optional `args: string[]`, and optional
  `env: Record<string,string>`.
- Unknown keys fail validation so typos are actionable.
- Missing file means built-in defaults:
  `defaultEngine: "copilot"` and `copilot: { command: "copilot", args: [] }`.

## Precedence

Lowest to highest:

1. Built-in defaults.
2. Config file.
3. Per-job persisted prompt settings (`action.engine`, `action.args`,
   `action.cwd`, `action.env`, `action.envFile`, `action.timeoutSec`,
   session settings).
4. Explicit call arguments at creation/update time such as CLI flags, MCP tool
   arguments, or direct client input.

Creation/update normalizes omitted prompt engines from the effective config so
persisted jobs remain explicit and portable. Runtime reads the current config
for engine command, default args, and engine env because those are machine-local
startup settings.

## Engine command construction

For a prompt run:

1. Resolve `engineName = action.engine ?? effectiveConfig.defaultEngine`.
2. Resolve `engine = effectiveConfig.engines[engineName]`; missing engine is a
   typed core error telling the user to add it or change the job/default.
3. Build argv as `engine.args + [prompt] + action.args + session args`.
4. Spawn `engine.command` with `shell: false`.
5. Merge env as `process.env < engine.env < envFile < action.env`.

This keeps `agency` configurable as:

```json
{ "command": "agency", "args": ["cp", "--logs-dir=XYZ"] }
```

## Core/client API

Core module owns `loadConfig`, `readConfigFile`, `writeConfigFile`,
`initConfig`, `validateConfigFile`, key-path get/set/remove, engine
list/add/update/remove, and `buildPromptRunCommand`.

Client exposes the same conceptual operations: `getConfig`, key-path
get/set/remove, engine list/add/update/remove, `initConfig`, and
`validateConfig`.

## CLI shape

All commands support global `--json`.

- `crontick config get [path]`
- `crontick config set <path> <json-value>`
- `crontick config unset <path>`
- `crontick config engines`
- `crontick config engines add <name> --command <cmd> [--arg <arg>...] [--env KEY=VALUE...]`
- `crontick config engines update <name> [--command <cmd>] [--arg <arg>...] [--env KEY=VALUE...]`
- `crontick config engines remove <name>`
- `crontick config init [--force]`
- `crontick config validate [path]`

## MCP shape

MCP tools mirror the client names and CLI semantics:

- `crontick_config_get`
- `crontick_config_set`
- `crontick_config_unset`
- `crontick_config_engine_list`
- `crontick_config_engine_add`
- `crontick_config_engine_update`
- `crontick_config_engine_remove`
- `crontick_config_init`
- `crontick_config_validate`

Resource: `crontick://config/effective` returns the effective merged config.
