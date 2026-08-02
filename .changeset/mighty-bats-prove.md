---
"crontick": major
---

BREAKING: creating a job is no longer a silent upsert. Duplicate ids now fail with
`JOB_ALREADY_EXISTS` unless you pass explicit overwrite intent (`--force` on the CLI,
`force: true` in the library/MCP, or `?force=1|true` on the HTTP route). Use update when
you want to mutate an existing job in place.

Related fixes in the same release:

- Invalid schedules are validated before persistence, so a failed create/update no longer
  leaves a broken or partially replaced job behind.
- On Windows, PowerShell script jobs now report truthful failures for non-terminating
  errors, uncaught terminating errors, command-not-found, missing-module failures, and
  native non-zero exits; an explicit `exit N` still wins.
- On Windows, PowerShell script output is captured as faithful UTF-8 regardless of the
  console OEM code page, including output split across stream chunk boundaries.
- Secret redaction now covers a wider set of token/key shapes and is applied consistently
  across config reads, run/log read surfaces, and dashboard data.
- Pre-spawn/setup failures now totalize runs as failed instead of leaving invariant-
  breaking runner rejections behind.
