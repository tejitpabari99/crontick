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
- `prompt` actions always use `shell=false` and pass prompt/engine args as argv elements
- `script` actions execute through an explicit shell choice
- job definitions are validated by Zod before persistence or execution

## Log redaction

Run logs are redacted for common secrets before they are stored or returned:

- GitHub tokens (`ghp_...`)
- AWS-style access keys (`AKIA...`)
- bearer tokens and selected env-style secret patterns

Binary output is preserved without lossy text redaction.

Prompt text and raw prompt engine arguments are stored in job JSON and may be visible to local
process inspection while a run is active. Do not put secrets in prompts or args; use `env`/`envFile`
for secret material when a job needs it.

## Operational guidance

- keep jobs self-contained
- prefer `exec` when shell features are not needed
- use `envFile` or `env` for secrets, never hardcode them into scripts committed to source control
- do not expose the daemon port through SSH forwarding, reverse proxies, or firewall rules
