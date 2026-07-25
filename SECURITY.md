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
