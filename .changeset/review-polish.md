---
"crontick": patch
---

Review polish: route the reuseSession-ignored notice to the `crontick` log stream, derive the `getLogs` source-validation message (and MCP/daemon schemas) from a single canonical `LOG_SOURCES` module, remove the orphaned `DashboardStartResult`/`DashboardStopResult` exports, use Commander's `InvalidArgumentError` for integer option coercion, and avoid per-chunk transcript-tail reallocation during prompt session-id capture.
