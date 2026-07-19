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
