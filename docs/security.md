# Security

## Trust boundary

crontick is designed for **local-user automation**. The daemon API listens on `127.0.0.1` only and rejects non-loopback remote addresses.

## API posture

- no bearer tokens
- no remote binding
- no HTTP MCP endpoint
- dashboard assets are path-normalized before being served

## Process execution

- `exec` actions always use `shell=false`
- `script` actions execute through an explicit shell choice
- job definitions are validated by Zod before persistence or execution

## Log redaction

Run logs are redacted for common secrets before they are stored or returned:

- GitHub tokens (`ghp_...`)
- AWS-style access keys (`AKIA...`)
- bearer tokens and selected env-style secret patterns

Binary output is preserved without lossy text redaction.

## Autostart integrity

Windows autostart writes a generated VBS shim under the crontick data directory and registers it in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Re-run `crontick autostart install` to regenerate it.

## Windows autostart & EDR alerts

crontick registers a VBS shim under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` (user-scope only, never HKLM) so the daemon starts on login. Registration uses the native Win32 `RegSetValueExW` API via `registry-js`, not `reg.exe`, so EDR tools like Microsoft Defender for Endpoint should not flag the `reg add` persistence pattern.

On corp-managed devices with aggressive EDR, unsigned first-run of any new binary may still trigger reputation-based alerts until Microsoft's Intelligent Security Graph classifies the file. Submit `crontick.exe` to https://www.microsoft.com/en-us/wdsi/filesubmission for known-good scoring if needed.

Users can inspect or remove the entry manually with `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v crontick-daemon` and `crontick autostart remove`.

The crontick test suite mocks the registry API by default and does not touch the real HKCU\Run key. A separate set of end-to-end tests that DO write to the real registry (under a scratch value name) is gated behind `CI=true` / `CRONTICK_RUN_REGISTRY_TESTS=1`, so `npm test` on a developer machine will not trigger EDR persistence alerts.

## Operational guidance

- keep jobs self-contained
- prefer `exec` when shell features are not needed
- use `envFile` or `env` for secrets, never hardcode them into scripts committed to source control
- do not expose the daemon port through SSH forwarding, reverse proxies, or firewall rules
