# crontick CLI cookbook

Copy-pasteable command sequences for common tasks using the `crontick` CLI binary.

The binary name is **`crontick`** (see `package.json#bin`).

## Shell quoting note

Examples use POSIX single-quote (`'...'`) by default. On **Windows CMD**, replace single quotes with double quotes. On **PowerShell**, single quotes work but JSON values may need escaping with backticks or double quotes around the outer string.

---

## Job creation

### Interval script job

```sh
crontick new hello-world --every 60 --script 'echo "hello from crontick"'
```

Expected: prints the created job JSON with `id: "hello-world"`, `schedule.kind: "interval"`.

### Cron job with timezone

```sh
crontick new morning-report --cron '0 9 * * 1-5' --tz America/New_York --script 'echo "Good morning"'
```

Expected: job with `schedule.kind: "cron"`, `schedule.tz: "America/New_York"`.

### Exec job (no shell)

```sh
crontick new node-hello --every 30 --exec node -- -e "console.log('hi')"
```

Expected: job with `action.kind: "exec"`, `action.command: "node"`.

### Prompt job

```sh
crontick new daily-prompt --cron '0 0 * * *' --prompt 'Summarize system status' --engine copilot
```

Expected: job with `action.kind: "prompt"`, `action.engine: "copilot"`.

### One-shot job

```sh
crontick new cleanup-once --at '2026-08-01T00:00:00Z' --script 'echo "one-shot done"'
```

Expected: job with `schedule.kind: "one-shot"`, `schedule.runAt` matching the given ISO time.

---

## Job management

### List all jobs

```sh
crontick list
```

### Get a single job

```sh
crontick get hello-world
```

### Update a job

```sh
crontick update hello-world --every 120 --desc 'Now runs every 2 minutes'
```

### Enable / disable

```sh
crontick disable hello-world
crontick enable hello-world
```

### Delete a job

```sh
crontick delete hello-world
```

---

## Runs and logs

### Trigger immediate run

```sh
crontick run-now hello-world
```

Expected: prints `{ "runId": "<uuid>" }`.

### List runs

```sh
crontick runs list --job hello-world --limit 5
```

### Get a specific run

```sh
crontick runs get <runId>
```

### View logs

```sh
crontick logs <runId> --tail 20
```

### Cancel a running run

```sh
crontick cancel-run <runId>
```

---

## Schedules

### Validate a schedule

```sh
crontick schedule validate '{"kind":"cron","cron":"0 9 * * 1-5"}'
```

### Preview next run times

```sh
crontick schedule preview '{"kind":"cron","cron":"0 9 * * 1-5","tz":"America/New_York"}' --limit 5
```

---

## Stats

```sh
crontick stats summary
crontick stats job hello-world
```

---

## Daemon management

```sh
crontick daemon start
crontick daemon status
crontick daemon reload
crontick daemon restart
crontick daemon stop
```

---

## Configuration

### Initialize config file

```sh
crontick config init
```

### Read / write config values

```sh
crontick config get
crontick config get defaultEngine
crontick config set defaultEngine copilot
crontick config unset defaultEngine
```

### Engine management

```sh
crontick config engines
crontick config engines add my-engine --command my-cli --arg '--verbose'
crontick config engines update my-engine --command my-cli-v2
crontick config engines remove my-engine
```

### Validate config file

```sh
crontick config validate
```

---

## Export / Import

```sh
crontick export --out jobs-backup.json
crontick import jobs-backup.json
```

---

## Doctor (health check)

```sh
crontick doctor
```

Expected: prints checks for Node version, SQLite, data directory, daemon connectivity, and MCP.

---

## JSON output

Append `--json` to any command for machine-readable output:

```sh
crontick list --json
crontick daemon status --json
```

---

## Verbose diagnostics

Append `-v` or `--verbose` for debug-level logs to stderr:

```sh
crontick new test-verbose --every 10 --script 'echo hi' --verbose
```
