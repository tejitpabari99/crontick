---
"crontick": minor
---

BREAKING (CLI): `-C, --cwd <dir>` on `jobs new` / `jobs update` is removed and replaced by `--dir <path>` (long option only). `-C` and `--cwd` are now unknown options, including after `--`. The stored `cwd` field, MCP `cwd` and `--file` input are unchanged. Also: schedule flag help uses clearer wording and `jobs new --help` gains a "How to schedule" footer; new `crontick runs delete` command, `crontick_run_delete` MCP tool and `deleteRuns` client method (surface capability `delete-runs`); job id-or-alias lookup is consolidated in one resolver and the alias `all` is now reserved (rejected on create, update and import).
