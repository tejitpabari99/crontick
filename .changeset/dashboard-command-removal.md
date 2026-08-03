---
"crontick": patch
---

Remove the `dashboard` CLI command group and `crontick_dashboard_*` MCP tools; the dashboard is always served by the daemon, and `crontick info` (and `crontick_info`) now expose its URL via `dashboardUrl`.
