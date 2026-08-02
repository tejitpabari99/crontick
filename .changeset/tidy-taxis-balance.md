---
'crontick': minor
---

Fix AWS secret redaction to require high-confidence context instead of treating every bare
40-character base64-ish token as a secret. This intentionally preserves benign values such
as `aGVsbG8gd29ybGQgZnJvbSBjcm9udGljayBxYQ==` on logs tail, dashboard data, exports, and
other shared read surfaces.

BREAKING: unlabeled standalone 40-character base64-ish values that were previously
redacted by the old AWS fallback heuristic are no longer redacted unless a nearby
AWS-specific key hint or access-key-id pair proves the value is credential material.
