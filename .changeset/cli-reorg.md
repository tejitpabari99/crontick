---
"crontick": patch
---

Reorganize the CLI and MCP surfaces around grouped jobs/runs/stats/share commands: config now prints the file path, info reports version/runtime/path status, runs delete removes run history/log rows, and jobs schedule previews existing jobs. The global --json flag and dedicated script/exec/config CLI/MCP exposure were removed while script and exec remain available through job JSON and the core client; CLI errors now render as clean colored single-line messages with verbose diagnostics on request.
