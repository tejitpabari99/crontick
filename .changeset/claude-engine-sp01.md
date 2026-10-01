---
"crontick": minor
---

Make Claude Code the sole built-in default prompt engine through a typed
engine-adapter registry, while keeping custom engines on the raw adapter by
default. Add configurable job defaults for overlap, timeout, and retry.

**Breaking (pre-1.0):** the built-in Copilot engine is removed. A config that
still selects Copilot must define it explicitly; jobs needing that engine
must use a custom raw engine entry. The job CLI uses `--runner` in place
of `--engine` (`--alias`/`-a` names the job).

Claude runs pre-assign session IDs, parse structured results, and expose cost,
turns, redacted usage, transcript path, and engine status through library,
CLI, and MCP run fields. Run and statistics surfaces also expose `skipped`
separately from `canceled`, plus aggregate cost and turns. Unrecognized
long job flags pass through to engine arguments, while crontick-managed
flags remain reserved.
