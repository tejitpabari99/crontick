# crontick CLI cookbook

Copy-pasteable command sequences for common tasks using the `crontick` CLI binary.

The binary name is **`crontick`** (see `package.json#bin`). CLI output is human-readable; use the library or MCP surface for structured JSON automation.

## Shell quoting note

Examples use POSIX single quotes (`'...'`) by default. On **Windows CMD**, replace single quotes with double quotes. On **PowerShell**, single quotes work but JSON values may need escaping with backticks or double quotes around the outer string.

---

## Job creation

### Interval prompt job

```sh
crontick jobs new --every 60 --prompt 'Say hello from crontick' --alias hello-world
```

Expected: prints the created job with a generated GUID `id` and alias `hello-world`.

### Cron prompt job with timezone

```sh
crontick jobs new --cron '0 9 * * 1-5' --tz America/New_York --prompt 'Write a morning report' --engine copilot --alias morning-report
```

Expected: job with `schedule.kind: "cron"`, `schedule.tz: "America/New_York"`, and `action.kind: "prompt"`.

### Script job via JSON file

Create `script-job.json`:

```json
{
  "alias": "script-demo",
  "schedule": { "kind": "interval", "everySec": 60 },
  "action": { "kind": "script", "script": "echo \"hello from crontick\"" }
}
```

Then run:

```sh
crontick jobs new --file script-job.json
```

### Exec job via JSON file

Create `exec-job.json`:

```json
{
  "alias": "node-hello",
  "schedule": { "kind": "interval", "everySec": 30 },
  "action": { "kind": "exec", "command": "node", "args": ["-e", "console.log('hi')"] }
}
```

Then run:

```sh
crontick jobs new --file exec-job.json
```

### One-shot prompt job

```sh
crontick jobs new --at '2026-08-01T00:00:00Z' --prompt 'Remind me that the one-shot fired' --alias cleanup-once
```

---

## Job management

### List all jobs

```sh
crontick jobs list
```

### Get a single job

```sh
crontick jobs get hello-world
```

### Update a job

```sh
crontick jobs update hello-world --every 120 --desc 'Now runs every 2 minutes'
```

### Enable / disable

```sh
crontick jobs update hello-world --disable
crontick jobs update hello-world --enable
```

### Preview upcoming fires

```sh
crontick jobs schedule hello-world -n 5
```

### Delete a job

```sh
crontick jobs delete hello-world
```

---

## Runs and logs

### Trigger immediate run

```sh
crontick jobs run-now hello-world
```

Expected: prints `runId: <uuid>`.

### List runs

```sh
crontick runs list --job hello-world --limit 5
crontick runs list --status success --limit 5
```

### Get a specific run

```sh
crontick runs get <runId>
```

### View logs

```sh
crontick runs logs <runId> --tail 20
crontick runs logs <runId> engine --tail 20
crontick runs logs <runId> crontick --tail 20
```

### Cancel a running run

```sh
crontick runs cancel <runId>
```

### Delete run history

```sh
crontick runs delete <runId>
crontick runs delete --all --force
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

Find the config file:

```sh
crontick config
```

Edit `config.json` by hand. Most settings apply automatically on the next run; changing `retention.maxRunsPerJob` requires:

```sh
crontick daemon restart
```

---

## Export / Import

```sh
crontick share export --out jobs-backup.json
crontick share export --out jobs-and-runs-backup.json --include-runs
crontick share import jobs-backup.json
```

`--include-runs` adds a `runs` array to the export; import restores it archivally when present.

---

## Info and Doctor

```sh
crontick info
crontick doctor
```

`info` prints version, runtime, paths, and daemon status. `doctor` prints health checks and exits non-zero if any check fails.

---

## Verbose diagnostics

Append `-v` or `--verbose` for debug-level logs to stderr:

```sh
crontick jobs new --every 10 --prompt 'echo hi' --alias test-verbose --verbose
```
