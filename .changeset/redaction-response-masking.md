---
'crontick': patch
---

Redact secret-like job `action.env` values from job create/list/get/update responses and redact secret-like config values from config mutation responses across the library, CLI, MCP, and daemon HTTP surfaces.
