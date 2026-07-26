---
"crontick": patch
---

Fix `crontick update` (and the equivalent `crontick_job_update` MCP tool and HTTP `PUT` call) silently
resetting fields you didn't mean to touch. Previously, updating a job could unintentionally wipe out:

- `overlap`, because `--overlap` had a hardcoded default of `skip` on the CLI, so an update that
  omitted `--overlap` could reset an existing `queue`/`cancel-previous` policy back to `skip`, and
  `--overlap skip` could never be set explicitly on update at all.
- `shell` on script actions, `envFile`, and `timeoutSec`, because any action update replaced the whole
  action instead of merging it, so touching one action field (e.g. `--script`) silently discarded the
  others.
- `args` and `reuseSession` on exec/prompt actions, for the same reason — a partial action update
  reset `args` to empty and `reuseSession` to `false`.
- `retry.backoffSec`, because a partial retry update (changing only the retry count) reset the backoff
  delay back to its default.
- the prompt `engine`, because it was re-resolved to the configured default on every update instead of
  being left alone.

All of the above are now preserved across partial updates unless you explicitly provide a new value,
identically on the CLI, HTTP API, and MCP surfaces. Switching an action's kind (e.g. script to exec)
still fully replaces the action, since the old action's fields don't apply to the new kind.
