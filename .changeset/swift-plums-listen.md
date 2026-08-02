---
"crontick": minor
---

Run history is capped per job: crontick keeps at most `retention.maxRunsPerJob` runs (and their
logs) per job, default 100, configurable in `config.json` (range 1-100,000). Once a job exceeds
the cap, the oldest terminal runs (never a currently active `running`/`queued` run) are evicted
first. The cap can be changed at any time and applied to a running daemon with `crontick daemon
reload` -- no restart required.

Eviction is a hard delete with no automatic export, prompt, or undo. If you want to keep run
history beyond the cap, use `crontick export --include-runs` (or the equivalent `includeRuns`
option on the library/MCP export call) to snapshot it, and `crontick import` to restore it into
another store.

BREAKING: this is a major bump because eviction is destructive and on by default, not opt-in. A
job that accumulates more than 100 runs will have its oldest history pruned automatically as part
of normal operation.
