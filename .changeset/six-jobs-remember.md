---
"crontick": patch
---

`crontick update` (and the equivalent `crontick_job_update` MCP tool and HTTP `PUT` call) preserves
every field you don't explicitly touch:

- `overlap` is left as-is unless you pass `--overlap` explicitly -- there is no hidden default that
  resets an existing `queue`/`cancel-previous` policy back to `skip`.
- Updating one action field (e.g. `--script`) merges into the existing action instead of replacing
  it outright, so `shell`, `envFile`, and `timeoutSec` on script actions, and `args` and
  `reuseSession` on exec/prompt actions, are preserved unless you provide new values.
- A partial `retry` update (e.g. changing only the retry count) preserves the existing
  `backoffSec`.
- The prompt `engine` is left alone across updates rather than being re-resolved to the configured
  default.

This holds identically on the CLI, HTTP API, and MCP surfaces. Switching an action's kind (e.g.
script to exec) fully replaces the action, since the old action's fields don't apply to the new
kind.
