# Configuration

crontick reads one JSON config file from the existing state directory:

```text
.crontick\config.json
```

That path is relative to `CRONTICK_HOME` when set. Without `CRONTICK_HOME`,
crontick uses its platform data directory and stores `config.json` there.

Missing config is valid. The built-in effective config is:

```json
{
  "defaultEngine": "copilot",
  "engines": {
    "copilot": {
      "command": "copilot",
      "args": [],
      "env": {}
    }
  }
}
```

## Schema

```json
{
  "defaultEngine": "copilot",
  "engines": {
    "engine-name": {
      "command": "program-on-path-or-absolute-path",
      "args": ["default", "arguments"],
      "env": {
        "NAME": "value"
      }
    }
  }
}
```

- `defaultEngine` is used when a prompt job does not specify `action.engine`.
- `engines` is keyed by engine name.
- `command` is the executable crontick starts with `shell: false`.
- `args` are always passed before crontick appends the prompt, per-job args,
  and session flags.
- `env` is optional default environment for that engine.

## Example: Copilot and Agency

```json
{
  "defaultEngine": "copilot",
  "engines": {
    "copilot": {
      "command": "copilot",
      "args": ["-p"],
      "env": {}
    },
    "agency": {
      "command": "agency",
      "args": ["cp", "--logs-dir=Q:\\Repos\\crontick\\.crontick\\agency-logs"],
      "env": {}
    }
  }
}
```

`agency` is not built in; it is just a configurable engine entry.

## Precedence

Lowest to highest:

1. Built-in defaults.
2. `.crontick\config.json`.
3. Per-job settings such as `action.engine`, `action.args`, `cwd`, `env`,
   `envFile`, `timeoutSec`, and session settings.
4. Explicit call arguments from CLI flags, MCP tool inputs, or client input.

At run time, prompt jobs resolve the configured engine, start its `command`,
pass configured `args`, append the prompt, append per-job args, and append
`--session-id=...` when the job has a session id.

## CLI

```sh
crontick config init
crontick config get
crontick config get defaultEngine
crontick config set defaultEngine "\"copilot\""
crontick config engines
crontick config engines add agency --command agency --arg cp --arg "--logs-dir=Q:\Logs"
crontick config engines update agency --arg cp --arg "--logs-dir=Q:\NewLogs"
crontick config engines remove agency
crontick config validate
```

Add `--json` before `config` for machine-readable output.

## Client API

```ts
const client = createClient();
client.getConfig();
client.getConfigValue("engines.copilot.command");
client.setConfigValue("defaultEngine", "copilot");
client.listEngines();
client.addEngine("agency", { command: "agency", args: ["cp"], env: {} });
client.updateEngine("agency", { args: ["cp", "--logs-dir=Q:\\Logs"] });
client.removeEngine("agency");
client.initConfig({ force: true });
client.validateConfig();
```

## MCP

The MCP server exposes matching tools:

- `crontick_config_get`
- `crontick_config_set`
- `crontick_config_unset`
- `crontick_config_engine_list`
- `crontick_config_engine_add`
- `crontick_config_engine_update`
- `crontick_config_engine_remove`
- `crontick_config_init`
- `crontick_config_validate`

It also exposes `crontick://config/effective`.
