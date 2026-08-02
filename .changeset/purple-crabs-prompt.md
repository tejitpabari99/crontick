---
"crontick": minor
---

Add first-class prompt cron jobs for Copilot and Agency. Prompt jobs can be created from the CLI,
client, HTTP API, or MCP with `action.kind: "prompt"`, raw engine args, explicit sessions, and
first-run session reuse. Prompt files are normalized to persisted prompt text before jobs are
stored.

The daemon is demand-started: any daemon-backed CLI, MCP, or client operation starts it
automatically on first use, and `crontick daemon start` is available for explicit manual
lifecycle control. There is no install-time or login/startup registration -- crontick does not
register itself to launch automatically when you log in or start your machine; see
`docs/concepts/daemon-lifecycle.md` and ADR 0003 for the reasoning.
