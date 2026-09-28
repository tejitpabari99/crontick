# crontick CLI cookbook

Copy-pasteable command sequences for common tasks using the `crontick` CLI binary.

The binary name is **`crontick`** (see `package.json#bin`). CLI output is human-readable; use the library or MCP surface for structured JSON automation.

## Shell quoting note

Examples use POSIX single quotes (`'...'`) by default. On **Windows CMD**, replace single quotes with double quotes. On **PowerShell**, single quotes work but JSON values may need escaping with backticks or double quotes around the outer string.

---

## Job creation

### Interval prompt job

```sh
crontick jobs new --every 60 --prompt 'Say hello from crontick' --name hello-world
```

Expected: prints the created job with a generated GUID `id` and alias `hello-world`.

### Cron prompt job with timezone

```sh
crontick jobs new --cron '0 9 * * 1-5' --tz America/New_York --prompt 'Write a morning report' --runner claude --name morning-report
```

Expected: job with `schedule.kind: "cron"`, `schedule.tz: "America/New_York"`, and `action.kind: "prompt"`.

### Prompt job via JSON file

Create `release-notes-job.json`:

```json
{
  "alias": "release-notes",
  "schedule": { "kind": "interval", "everySec": 3600 },
  "action": { "kind": "prompt", "prompt": "Draft release notes from recent commits", "engine": "claude" }
}
```

Then run:

```sh
crontick jobs new --file release-notes-job.json
```

### Prompt job with session reuse via JSON file

Create `incident-triage-job.json`:

```json
{
  "alias": "incident-triage",
  "schedule": { "kind": "interval", "everySec": 1800 },
  "action": { "kind": "prompt", "prompt": "Continue triaging the incident queue", "engine": "claude", "reuseSession": true },
  "overlap": "skip"
}
```

Then run:

```sh
crontick jobs new --file incident-triage-job.json
```

`reuseSession` captures the engine session id after a run so the agent keeps conversational context on the next fire; it requires `overlap: "skip"` (the default).

### One-shot prompt job

```sh
crontick jobs new --at '2026-08-01T00:00:00Z' --prompt 'Remind me that the one-shot fired' --name cleanup-once
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

## Stats

```sh
crontick stats summary
crontick stats job hello-world
```

---

## Info and lightweight admin

```sh
crontick info
crontick info doctor
crontick info daemon reload
crontick info daemon stop
```

`info` prints version, runtime, config path, storage paths, daemon status, and dashboard URL. Edit `config.json` by hand; `info` tells you where it lives. If `retention.maxRunsPerJob` changes, stop the daemon with `crontick info daemon stop` and then run any daemon-backed command to start it again.

---

## Export / Import

```sh
crontick share export --out jobs-backup.json
crontick share export --out jobs-and-runs-backup.json --include-runs
crontick share import jobs-backup.json
```

`--include-runs` adds a `runs` array to the export; import restores it archivally when present.

---


---

## Verbose diagnostics

Append `-v` or `--verbose` for debug-level logs to stderr:

```sh
crontick jobs new --every 10 --prompt 'echo hi' --name test-verbose --verbose
```
