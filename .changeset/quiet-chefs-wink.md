---
"crontick": patch
---

Document the round-2 QA defect fixes now implemented in core behavior:

- Secret redaction is now documented as one shared contract across persisted logs and all read surfaces, including streaming multi-line private-key handling, precise structured key-hint matching, and the two-tier AWS secret heuristic.
- Job create/update now fail with `ENV_FILE_ERROR` before persistence when `action.envFile` is missing or unreadable, leaving the previously stored job state unchanged.
- BOM-prefixed JSON is accepted for create/update `--file`, CLI import, and config-file reads/validation, and malformed JSON now reports the file path, parse location, and expected shape instead of surfacing a raw parser failure.
