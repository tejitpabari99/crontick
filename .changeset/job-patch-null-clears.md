---
"crontick": minor
---

Job patches accept `null` to remove `description`, `action.timeoutSec` and `action.sessionId` on every surface (library `updateJob`, MCP `crontick_job_update`, HTTP `PUT`), and the CLI gains `crontick jobs update <job> --unset <timeout|session-id|desc>` (repeatable and/or comma-separated). Other fields cannot be nulled.
