# Troubleshooting

## Run doctor first

```sh
crontick doctor
```

Typical output:

```text
✓ Node.js >= 22.5
✓ node:sqlite
✓ data dir writable
✓ port file readable
✓ daemon reachable
✓ dashboard reachable
```

## Common issues

### `Daemon is not running`

Start it with:

```sh
crontick daemon start
```

### `node:sqlite` import errors

Use Node.js 22.5+; older Node versions may need the daemon re-exec shim or a newer runtime.

### Dashboard opens but API fails

Check `crontick daemon status` and inspect the latest daemon log in the crontick data directory `logs/` folder.

### Autostart is unsupported on my platform

v1 manages autostart only on Windows. On macOS/Linux use `crontick autostart status` to get manual setup instructions.

### A run keeps failing

- `crontick logs <run-id> --tail 100`
- `crontick get <job-id> --json`
- `crontick doctor`

For MCP workflows, load the run via `crontick_run_get` and `crontick_run_logs_tail`.

### Schedule seems wrong

Validate and preview it first:

```sh
curl -X POST http://127.0.0.1:<port>/api/schedules/validate -H "content-type: application/json" -d '{"kind":"cron","cron":"0 9 * * *"}'
curl -X POST http://127.0.0.1:<port>/api/schedules/preview -H "content-type: application/json" -d '{"schedule":{"kind":"cron","cron":"0 9 * * *"},"n":5}'
```
