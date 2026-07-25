# crontick

## 1.0.0

### Major Changes

- 6d2b540: Add first-class prompt cron jobs for Copilot and Agency. Prompt jobs can be created from the CLI,
  client, HTTP API, or MCP with `action.kind: "prompt"`, raw engine args, explicit sessions, and
  first-run session reuse. Daemon-backed CLI/MCP/client operations now start the daemon on demand;
  prompt files are normalized to persisted prompt text before jobs are stored.

  BREAKING: remove install-time and login/startup autostart registration surfaces. Users should let
  daemon-backed commands start the daemon on demand or run `crontick daemon start` explicitly when
  they want manual lifecycle control.

## Unreleased

### Minor Changes

- Add first-class prompt jobs with `action.kind: "prompt"`, `engine`, raw `args`, `sessionId`, and
  `reuseSession`.
- Add shared prompt-file normalization for CLI and programmatic client creation; persisted jobs store
  `prompt`, never `promptFile`.
- Expose prompt jobs consistently through CLI, HTTP API, programmatic client, and MCP.

## 0.1.1

### Patch Changes

- Add npm install troubleshooting documentation for corporate TLS/proxy failures.

## 0.1.0

### Minor Changes

- Initial public release: standalone cron daemon, CLI, dashboard, and MCP server for local scheduled
  jobs.
