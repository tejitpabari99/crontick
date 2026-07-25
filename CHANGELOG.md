# crontick

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
