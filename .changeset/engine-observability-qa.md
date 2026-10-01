---
'crontick': minor
---

Replace the Claude SessionEnd base64/eval hook with a plain helper script (`<dataDir>/hooks/session-end.cjs`), show `--settings <session-end-hook>` in stored commands, expose `logFile` on run get, and add display-only `usage` (normalized token counts) to run output.
