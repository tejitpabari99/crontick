---
"crontick": major
---

Run history is now capped per job. By default crontick keeps at most 100 runs (and their logs)
per job; configure this with `retention.maxRunsPerJob` in `config.json` (range 1-100,000).

**Upgrading prunes existing history.** The first time the daemon starts after upgrading to this
version, it walks every job and permanently deletes any runs beyond the cap, oldest first. This
happens automatically, with no confirmation prompt, no export, no dry-run, and no undo. If a job
already has more than 100 recorded runs, that extra history is gone as soon as the daemon starts.

**If you want to keep more than 100 runs per job, act before upgrading**: export or copy the run
history you care about (e.g. `crontick logs <run-id>` per run, or copy the `runs.db` file) before
installing this version, or raise `retention.maxRunsPerJob` in `config.json` before the daemon
starts for the first time on the new version so the backfill prunes to the higher cap instead of
the default 100.

The cap can also be changed at any time after upgrading: edit `retention.maxRunsPerJob` in
`config.json` and apply it to a running daemon with `crontick daemon reload` (no restart
required). Raising the cap only stops further eviction going forward -- it cannot restore runs
that were already pruned under the previous, lower cap.

BREAKING: this is a major bump because the behavior is destructive and on by default against
existing user data on every upgrade, not opt-in. Existing installs with more than 100 runs
recorded for any job will lose that history the first time they start this version, with no way
to recover it after the fact.
