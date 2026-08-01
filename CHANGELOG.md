# crontick

## 0.1.2

### Patch Changes

- Relocated all unit/vitest tests into `tests/unit/` (previously flat under `tests/`).
- Added an on-demand end-to-end integration test harness under `tests/integration/` (`npm run e2e`); not wired into CI.
- Removed superseded historical manual-test campaign docs.
- Added `docs/e2e-testing.md` documenting the E2E harness.
- Security: `Authorization: Bearer <token>` values are now fully redacted on the streaming/tail run-log read paths (CTD-025), closing a plaintext-token leak.
- Fix: single-field action patches (e.g. `shell`, `envFile`, or `timeout` alone) are now accepted on the library/HTTP and MCP surfaces, matching the CLI (CTD-026); modifier-only action patches (no primary source) are rejected on the MCP surface with a clear error.
- Docs: clarified the two envFile-related error classes (`ENV_FILE_ERROR` vs update-time `VALIDATION_ERROR`) in `docs/reference/errors.md`.

## 0.1.1

### Patch Changes

- Add npm install troubleshooting documentation for corporate TLS/proxy failures.

## 0.1.0

### Minor Changes

- Initial public release: standalone cron daemon, CLI, dashboard, and MCP server for local scheduled
  jobs.
