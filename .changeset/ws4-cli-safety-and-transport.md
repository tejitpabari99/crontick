---
"crontick": minor
---

The library client now uses a short-lived `node:http` loopback transport instead of
`fetch`/undici so Windows consumers can call `createClient()`, make a daemon-backed request,
and still exit cleanly. Library docs now also recommend setting `process.exitCode` and letting
Node exit naturally instead of calling `process.exit()` immediately after daemon-backed work.

BREAKING: the CLI-only `--env-file` flag has been renamed to `--job-env-file`. The old
spelling cannot be kept as an alias because Node.js intercepts `--env-file` before
crontick starts. Persisted job JSON and library/MCP/HTTP payloads still use `action.envFile`.
