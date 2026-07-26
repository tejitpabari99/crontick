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

<a id="npm-install-fails"></a>

## npm install fails with ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE

This error means the TLS handshake to the npm registry was rejected before npm could download the package. It is usually a client-machine TLS, Node.js, proxy, or Windows cipher-suite problem; the crontick package itself does not control this handshake.

### Diagnose the client machine

Run these commands from the same shell that fails:

```powershell
node --version
npm --version
where.exe node
where.exe npm
npm config get registry
npm config get strict-ssl
npm config get cafile
npm config get ca
npm config get proxy
npm config get https-proxy
npm config get noproxy
$env:NODE_EXTRA_CA_CERTS
$env:HTTPS_PROXY
$env:HTTP_PROXY
$env:NO_PROXY
$env:NODE_OPTIONS
$env:NODE_TLS_REJECT_UNAUTHORIZED
Invoke-WebRequest https://registry.npmjs.org/crontick -UseBasicParsing -MaximumRedirection 0 |
  Select-Object StatusCode, Headers
curl.exe -v https://registry.npmjs.org/crontick
[Net.ServicePointManager]::SecurityProtocol
Get-TlsCipherSuite | Where-Object { $_.Name -like '*ECDHE*' } | Select-Object -First 5 Name
```

### Common causes and fixes

1. **Portable Node is too old**
   - Symptom: the failing shell uses an old or unexpected `node.exe`, often from a portable tools directory, while another shell uses a newer Node.
   - Fix: install a modern Node runtime with `nvm install --lts`, or download Node 22+ from [nodejs.org](https://nodejs.org/). Open a new shell and confirm `node --version` prints `v22.5.0` or newer, then retry `npm install -g crontick`.

2. **Corporate TLS-inspecting proxy is not trusted by Node**
   - Symptom: the network uses a proxy or firewall such as Zscaler, Netskope, Fiddler, or another TLS-inspection product, and Node does not trust the intercepting root certificate.
   - Fix: locate the corporate root CA with `certutil -store Root`, export the intercepting certificate as a `.pem` file, then run:

     ```powershell
     setx NODE_EXTRA_CA_CERTS "C:\path\to\corp-root.pem"
     ```

     Restart the shell before retrying npm.

3. **npm TLS config is misconfigured**
   - Symptom: `npm config get cafile` points to a missing or malformed file, `ca` is unexpected, or `strict-ssl` has been disabled while troubleshooting.
   - Fix:

     ```powershell
     npm config delete cafile
     npm config set strict-ssl true
     npm cache clean --force
     ```

4. **Windows Schannel cipher-suite or TLS policy issue**
   - Symptom: PowerShell `Invoke-WebRequest` or `curl.exe -v` fails with the same handshake error, which means the OS TLS stack is affected too.
   - Fix: from an elevated PowerShell, enable a modern ECDHE cipher suite, then restart the failing shell:

     ```powershell
     Enable-TlsCipherSuite -Name "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256"
     ```

     See Microsoft Learn: [Enable-TlsCipherSuite](https://learn.microsoft.com/powershell/module/tls/enable-tlsciphersuite).

Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0` as a workaround. It disables TLS certificate verification for Node.js processes and is unsafe.

## Common issues

### `Daemon is not running`

Daemon-backed commands normally demand-start the daemon. If start/connect fails, crontick errors
include what was attempted, the failed path/exit/stderr excerpt when available, and a next command to
run. Start it explicitly with:

```sh
crontick daemon start
```

Then run `crontick doctor`. If it still fails, inspect the ensure log in the crontick data directory:
`logs/daemon.ensure.log`. crontick is not a supervisor; if the daemon died while idle, scheduled jobs
pause until you start it or run another daemon-backed command.

### Need more crontick diagnostics

Use `crontick --verbose ...` (or `-v`) or set `CRONTICK_VERBOSE=1`. Verbose output goes to stderr,
so `crontick --json --verbose ...` still writes parseable JSON to stdout. Daemon logs live under the
crontick data directory `logs/`: `daemon.ensure.log` for demand-start and `daemon-YYYY-MM-DD.log` for
daemon lifecycle/API/scheduler diagnostics. In verbose daemon mode, run logs can also contain
`[crontick:debug]` lines for spawn/retry/session decisions.

### `node:sqlite` import errors

Use Node.js 22.5+; older Node versions may need the daemon re-exec shim or a newer runtime.

### Dashboard opens but API fails

Check `crontick daemon status` and inspect the latest daemon log in the crontick data directory `logs/` folder.



### A run keeps failing

- `crontick logs <run-id> --tail 100`
- `crontick get <job-id> --json`
- `crontick doctor`

For MCP workflows, load the run via `crontick_run_get` and `crontick_run_logs_tail`.

### Schedule seems wrong

Validate and preview it first:

```sh
crontick schedule validate '{"kind":"cron","cron":"0 9 * * *"}'
crontick schedule preview '{"kind":"cron","cron":"0 9 * * *"}' --limit 5
```

### VALIDATION_ERROR on job create/update

Means the job definition fails Zod schema validation. Check that:

- `id` is kebab-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
- `schedule` has a valid `kind` (`cron`, `interval`, or `one-shot`)
- `action` has exactly one of `script`, `exec`, or `prompt`
- Prompt actions have `prompt` text (not empty) or use `--prompt-file`

Run with `--verbose` to see the full Zod error details.

### CONFIG_READ_ERROR or CONFIG_VALIDATION_ERROR

The `config.json` file is malformed or has invalid fields:

```sh
crontick config validate
```

If the file is corrupt, delete it and reinitialize:

```sh
crontick config init --force
```

### Daemon won't start: `Error: file is not a database`

This means `runs.db` (the SQLite run-history database) is corrupted. The daemon opens it
unconditionally on startup and does not attempt repair, so it fails to start entirely -- no jobs
run, scheduled or otherwise -- until the file is removed. Recovery:

1. Stop the daemon if it is still running (`crontick daemon stop`); if it never started, skip this.
2. Find the data directory: `CRONTICK_HOME` if set, otherwise the platform default (Windows
   `%LOCALAPPDATA%\crontick`, macOS `~/Library/Application Support/crontick`, Linux
   `~/.local/share/crontick`). `crontick doctor` also prints the resolved path.
3. Delete `runs.db` and its WAL side files in that directory: `runs.db`, `runs.db-wal`,
   `runs.db-shm`. All three must go together -- removing only `runs.db` can leave a stale
   `-wal`/`-shm` pair that the next open tries to replay against the new, empty database file.
4. Start the daemon again (`crontick daemon start`, or let the next daemon-backed command
   demand-start it). A fresh `runs.db` is created automatically.

**What this loses:** run history and logs only -- every past run, its stdout/stderr, exit code,
and timestamps. **Job definitions are not affected**: jobs are the JSON files under
`<dataDir>/jobs/`, a separate store from `runs.db`, and are untouched by this recovery.

**Confirm recovery:** `crontick doctor` should report the daemon and dashboard reachable again,
and `crontick list` should show your jobs unchanged with empty run history (`crontick logs
<job-id>` returns no runs until the job fires again). See
[internals/storage.md](internals/storage.md) for the on-disk schema and
[state-and-storage.md](concepts/state-and-storage.md) for the persistence model.

### DAEMON_START_LOCK_TIMEOUT

Another process is holding the startup lock. This typically means a parallel demand-start is
already in progress. Wait a few seconds and retry. If it persists, remove the stale lock file
from the data directory (`daemon.ensure.lock`) and retry.

### ENV_FILE_ERROR

The `--env-file` path does not exist or cannot be read. Verify the path is correct and the
file is readable. Relative paths resolve against the job's `cwd` (or the daemon's working
directory if no `cwd` is set).

### My old runs disappeared

Each job keeps at most `retention.maxRunsPerJob` runs (default `100`); older runs (and their
logs) are pruned automatically and permanently — eviction has no dry-run, warning, or undo. This
is a per-job **count** cap only: a job that fires every minute keeps far less calendar history
than a job that fires monthly under the same cap. If you need to keep more history, raise
`retention.maxRunsPerJob` in `config.json` and run `crontick daemon reload` (existing runs beyond
the old cap that were already pruned cannot be recovered after the fact). To avoid losing history
in the first place, back it up before it is evicted: `crontick export --include-runs` captures
every job's run history, and `crontick import` restores it — see
[cli.md](reference/cli.md#export). See
[state-and-storage.md](concepts/state-and-storage.md#run-history-retention) and
[configuration.md](reference/configuration.md).

### `crontick daemon stop` reports `mode: "hard-kill"` instead of `"graceful"`

`crontick daemon stop` (and `daemon restart`) prefer `POST /api/daemon/stop`, an in-process
graceful shutdown that works identically on every platform, including Windows, where OS signals
sent to another process do not invoke Node's signal handlers at all. A result of `mode:
"hard-kill"` means the HTTP route could not be reached, so `stopDaemon()` fell back to a raw
`SIGTERM`/process-kill instead — this is the only path left when the daemon is already wedged or
unresponsive. Common causes:

- **Stale or missing `daemon.port` file.** Run `crontick doctor` to check daemon reachability;
  if the port file is stale, the next `crontick daemon start` will overwrite it.
- **The daemon is deadlocked or otherwise not answering HTTP**, in which case the hard-kill
  fallback is the correct, intended recovery path, not a bug.

After a hard-kill (on any platform), any run whose child process is still alive is picked up by
the next daemon start's orphan reconciliation (adopted if still alive, canceled if not) — see
[daemon-lifecycle.md](concepts/daemon-lifecycle.md#shutdown) and
[storage.md](internals/storage.md#orphan-reconciliation).

For all error codes see [docs/reference/errors.md](reference/errors.md).
