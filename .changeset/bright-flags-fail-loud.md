---
"crontick": minor
---

BREAKING: `crontick update` no longer silently succeeds when modifier flags cannot identify what to patch.

The CLI now fails loudly and leaves the stored job unchanged when you pass any of these flags without the required companion input:

- `--job-env-file` without `--script`, `--exec`, `--prompt`, or `--prompt-file`
- `--shell` without `--script`, `--exec`, `--prompt`, or `--prompt-file`
- `--timeout` without `--script`, `--exec`, `--prompt`, or `--prompt-file`
- `--tz` without `--cron` (including `--tz` by itself or alongside `--every` / `--at`)

Also document and test the supported success paths:

- `crontick update ... --cron <expr> --tz <tz>` updates a cron schedule's timezone
- library and MCP updates continue to use explicit `schedule` / `action` objects for these changes
