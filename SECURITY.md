# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | Yes                |
| < 0.1   | No                 |

## Reporting a Vulnerability

To report a security vulnerability, please use the GitHub private security
advisory feature on this repository:

  https://github.com/tejitpabari99/crontick/security/advisories/new

Do not open a public issue for security reports. A maintainer will acknowledge
receipt within 72 hours and provide an initial assessment within 7 days.

## Expected Response Timeline

- Acknowledgement: within 72 hours
- Initial assessment: within 7 days
- Fix or mitigation for confirmed issues: best-effort within 30 days

## Scope

crontick is a local automation tool that executes user-provided commands (shell
scripts, executables, prompt-engine invocations) by design. Job definitions are
treated as trusted input -- arbitrary command execution via job configuration is
expected behavior, not a vulnerability.

The daemon HTTP API binds exclusively to the loopback interface (127.0.0.1). If
you discover a way to make it listen on non-loopback addresses, or a way for
unprivileged remote code to interact with the daemon, that is in scope.

Vulnerabilities in third-party dependencies should be reported upstream unless
crontick's usage of the dependency creates an exploitable path that does not
exist in isolation.

## Operational Guidance

- Keep jobs self-contained.
- Prefer `exec` actions when shell features are not needed (`shell=false`).
- Use `envFile` or `env` for secrets; never hardcode them into scripts committed to source control.
- Do not expose the daemon port through SSH forwarding, reverse proxies, or firewall rules.
- Prompt text and raw engine arguments are stored in job JSON and may be visible to local process inspection while a run is active. Do not put secrets in prompts or args.

## Windows autostart and security tools

`crontick autostart enable` on Windows registers a Task Scheduler logon task. There
is **no official way to pre-clear it** with Microsoft Defender or other EDR products:
no registration or signing program exists for persistence mechanisms, detections are
behavioural and reputation-based, and scheduled-task creation is itself a detection
point (MITRE ATT&CK T1053.005, Security event 4698, `schtasks.exe` command lines).
What crontick controls is looking like what it is:

- No LOLBin chain: no `wscript`, `cmd`, `powershell` or `conhost`. The only process the
  task launches is `node.exe` (`schtasks.exe` runs at enable and disable time only).
- Nothing of ours to sign or submit: crontick ships JavaScript only; `node.exe` from
  nodejs.org is Authenticode-signed by the OpenJS Foundation (check with
  `Get-AuthenticodeSignature`).
- Honest metadata: author `crontick`, a plain description stating origin and removal,
  `Hidden=false`, own `\crontick` folder visible in `taskschd.msc`.
- User scope: current-user SID, `LeastPrivilege`, no elevation, no SYSTEM, no registry
  or Run key writes.
- Plain-text arguments, no encoded commands; ephemeral install paths (`_npx`) are refused.
- Opt-in: created only by an explicit `crontick autostart enable`.

If a tool flags it anyway:

1. **Defender on an unmanaged machine:** submit the flagged file at
   https://www.microsoft.com/wdsi/filesubmission as "Software developer" with a
   description of the behaviour. There is nothing to submit unless the flagged file is ours.
2. **Corporate Defender for Endpoint / other EDR:** the tenant administrator adds an
   allow indicator (file hash or the OpenJS Foundation certificate) or an exclusion.
   Scope it to the exact path, parent and command line rather than a bare filename. The
   command line to allow is:

   ```
   "<path>\node.exe" "<path>\node_modules\crontick\dist\cli\index.js" daemon start [--home "<dir>"]
   ```
3. **Policy-disabled task creation:** group policy can prohibit new tasks. `enable` then
   fails with `AUTOSTART_UNAVAILABLE` (schtasks stderr as the reason) and writes nothing.

Remove the task at any time with `crontick autostart disable`.

For the full security model (trust boundary, loopback enforcement, redaction), see
[docs/architecture.md](docs/architecture.md#security-considerations).
