---
"crontick": major
---

Add first-class prompt cron jobs for Copilot and Agency. Prompt jobs can be created from the CLI,
client, HTTP API, or MCP with `action.kind: "prompt"`, raw engine args, explicit sessions, and
first-run session reuse. Daemon-backed CLI/MCP/client operations now start the daemon on demand;
prompt files are normalized to persisted prompt text before jobs are stored.

BREAKING: remove install-time and login/startup autostart registration surfaces. Users should let
daemon-backed commands start the daemon on demand or run `crontick daemon start` explicitly when
they want manual lifecycle control.
