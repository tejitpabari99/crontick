# Actions

Every job has an `action` describing what to run.

## `script`

Inline script body executed through a shell.

```json
{
  "kind": "script",
  "script": "$ErrorActionPreference = 'Stop'\nWrite-Output hello",
  "shell": "pwsh",
  "cwd": "C:\\work",
  "envFile": ".env",
  "timeoutSec": 60
}
```

Shell choices: `auto`, `bash`, `pwsh`, `cmd`.

## `exec`

Direct process execution with `shell=false`.

```json
{
  "kind": "exec",
  "command": "node",
  "args": ["-e", "process.exit(0)"],
  "cwd": "C:\\work",
  "envFile": ".env",
  "timeoutSec": 30
}
```

Use `exec` for safer argv-based invocation when you do not need a shell.

## `prompt`

First-class prompt execution through Copilot or Agency. Prompt actions are spawned with
`shell=false` and raw engine args are passed as argv elements without parsing.

```json
{
  "kind": "prompt",
  "prompt": "Summarize repository status and write a concise report",
  "engine": "copilot",
  "args": ["--silent", "--add-dir", "Q:\\Repos\\crontick"],
  "reuseSession": true,
  "cwd": "Q:\\Repos\\crontick",
  "timeoutSec": 600
}
```

Fields:

- `prompt` — required persisted prompt text
- `engine` — `copilot` or `agency`; defaults to `copilot`
- `args` — raw engine arguments preserved in order, including duplicates
- `sessionId` — explicit engine session id to pass every run
- `reuseSession` — capture the first successful run's session id, persist it, then reuse it

CLI and programmatic client input may use `promptFile` as creation sugar. It must point to a UTF-8
`.txt` file; the file is read before persistence and exports contain only `prompt`.

Command lines produced by the runner:

- Copilot: `copilot -p <prompt> <args...> [--session-id <id>]`
- Agency: `agency cp -p <prompt> <args...> [--session-id <id>]`

## Environment

- `env` adds explicit key/value pairs
- `envFile` loads dotenv-style `KEY=VALUE` lines
- explicit `env` values win over `envFile`
- secret-shaped keys from env files are intentionally never logged

## Timeout

`timeoutSec` maps to Node child-process timeout handling. Long-running jobs are killed and recorded as `canceled`, `timeout`, or `failed` depending on platform/process semantics.

## Retry

```json
{ "max": 2, "backoffSec": 30 }
```

Retries happen after failed attempts only. Success stops the retry loop.

## Overlap

- `skip` — cancel new run if another run is active
- `queue` — serialize runs per job
- `cancel-previous` — abort the active run and start the latest request

## Budgets

`maxRunsPerDay` limits scheduling attempts per UTC day. Exceeded runs are marked `canceled` with a budget error.

`maxTokensPerRun` is reserved for future LLM-integrated actions and is persisted today for forward compatibility.
