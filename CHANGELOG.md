# crontick

## 0.1.2

### Patch Changes

- Relocated all unit/vitest tests into `tests/unit/` (previously flat under `tests/`).
- Added an on-demand end-to-end integration test harness under `tests/integration/` (`npm run e2e`); not wired into CI.
- Removed superseded historical manual-test campaign docs.
- Added `docs/e2e-testing.md` documenting the E2E harness.

## 0.1.1

### Patch Changes

- Add npm install troubleshooting documentation for corporate TLS/proxy failures.

## 0.1.0

### Minor Changes

- Initial public release: standalone cron daemon, CLI, dashboard, and MCP server for local scheduled
  jobs.
