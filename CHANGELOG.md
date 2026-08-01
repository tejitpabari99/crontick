# crontick

## 0.1.2

### Patch Changes

- Relocated all unit/vitest tests into `tests/unit/` (previously flat under `tests/`).
- Added an on-demand end-to-end integration test harness under `tests/integration/` (`npm run e2e`); not wired into CI.
- Removed superseded historical manual-test campaign docs.
- Added `docs/e2e-testing.md` documenting the E2E harness.
- Security: `Authorization: Bearer <token>` values are now fully redacted on the streaming/tail run-log read paths (CTD-025), closing a plaintext-token leak.
- Fix: single-field action patches (e.g. `shell`, `envFile`, or `timeout` alone) are now accepted on the library/HTTP surface (CTD-026); modifier-only action patches (no prompt/script/command source) are intentionally rejected on the CLI and MCP surfaces with a clear, fail-loud error — the CLI has always enforced this; MCP now mirrors the same guard so agents receive an actionable error rather than silently mutating a job.
- Docs: clarified the two envFile-related error classes (`ENV_FILE_ERROR` vs update-time `VALIDATION_ERROR`) in `docs/reference/errors.md`.

## 0.1.1

### Patch Changes

- Add npm install troubleshooting documentation for corporate TLS/proxy failures.

## 0.1.0

### Minor Changes

- Initial public release: standalone cron daemon, CLI, dashboard, and MCP server for local scheduled
  jobs.
