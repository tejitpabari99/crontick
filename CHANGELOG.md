# crontick

## 0.1.1

### Patch Changes

- f24ae58: Windows autostart hardening and developer-experience improvements.

  - **feat(autostart)**: Replace `reg.exe` shell-out with direct Win32
    `RegSetValueExW` calls via the `registry-js` native module. This
    eliminates the `reg add HKCU\...\Run` command-line pattern that
    Microsoft Defender for Endpoint and other EDRs flag as a persistence
    IOC (MITRE T1547.001). Public API is unchanged.
  - **test**: Gate the two real-registry autostart tests behind
    `process.env.CI` (or `CRONTICK_RUN_REGISTRY_TESTS=1`) so `npm test`
    on developer machines no longer writes to `HKCU\...\Run` and no
    longer triggers EDR alerts on corp-managed devices.
  - **docs**: Add a troubleshooting entry for
    `ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE` errors on `npm install`
    (usually caused by corp TLS-inspecting proxies). Document the CI
    gating in `CONTRIBUTING.md` and `docs/security.md`.

## 0.2.0

### Minor Changes

- 16d759b: Initial public release (0.1.0): standalone cron daemon, CLI, and MCP server for local scheduled jobs.

## 0.1.0

### Minor Changes

- 6543bde: Initial public release (0.1.0): standalone cron daemon, CLI, and MCP server for local scheduled jobs.
