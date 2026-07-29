---
"crontick": minor
---

CLI, client, daemon, and MCP surface polish for the WS6 defect batch:

- `crontick logs --tail` and MCP `crontick_run_logs_tail` now count reconstructed text lines rather than raw stored log chunks.
- CLI error output now surfaces structured `details` in both text mode and `--json` mode.
- `crontick daemon start --json` and `crontick daemon restart --json` now emit structured lifecycle results; `--foreground --json` is rejected up front.
- Runner failures now distinguish a missing `action.cwd` from a genuinely missing binary. Exec, script, and prompt jobs fail before spawn with an explicit cwd-focused error when `action.cwd` does not exist or is not a directory.
- BREAKING: MCP single-run tools (`crontick_job_cancel_run`, `crontick_run_get`, and `crontick_run_logs_tail`) now require `id`; the legacy `runId` alias was removed entirely.
