---
"crontick": minor
---

Argument passing to `--exec`/`--prompt` jobs now has a primary, always-correct form: the
repeatable `--arg <value>` flag. Use it instead of `--` when you need arguments with spaces,
embedded quotes, or a leading dash -- it works identically on every shell and every Windows shim
(`crontick.cmd`, `crontick.ps1`, `npx crontick`). The `--` convenience form still works but is not
reliable through `crontick.ps1` on Windows (the shim drops a literal `--` before the script ever
sees it); a crontick flag placed after `--` is now rejected with an explicit error instead of
being silently absorbed as a literal job argument. See the CLI reference for the full
platform-by-platform behavior matrix.

Several run-lifecycle and reliability fixes, all user-visible:

- A run that hits its `timeoutSec` now records `status: "timeout"`, not `status: "canceled"` --
  the two were previously indistinguishable.
- On Windows, a `script` job using the default (`pwsh`/`powershell.exe`) shell is spawned attached
  to the daemon's console rather than detached, because a detached PowerShell process on Windows
  produces no output at all. This is the one case that does not survive the daemon exiting;
  every other job (including PowerShell jobs on Linux/macOS, and every `exec`/`prompt` job
  everywhere) is unaffected and continues to survive daemon restarts and shutdowns.
- Output truncation, once a run's captured stdout/stderr hits its byte cap, no longer splits a
  multi-byte UTF-8 character at the cut point.
- Process-liveness checks used for orphan/adoption reconciliation now compare a process's actual
  OS-reported start time against the run's recorded start time (not just whether *a* process with
  that pid exists), so a reused pid can no longer be mistaken for the run that originally owned
  it. The check now queries the OS once in bulk instead of once per process, so startup and
  ongoing polling are faster.
- `crontick daemon stop` (and the `POST /api/daemon/stop` route it calls) now escalates to
  `SIGTERM` then `SIGKILL` if a graceful stop is accepted but the process doesn't actually exit,
  and reports the true `mode` it used. The response also lists any runs still in progress
  (`activeRuns`) instead of silently leaving them unmentioned.
- Deleting a job now cancels that job's in-flight run, if it has one, instead of leaving it to run
  orphaned.
- Restoring runs via `crontick import`/`crontick_import` now validates every row individually:
  a malformed row or one referencing a job that no longer exists is skipped and reported, without
  failing the rest of the batch.
- A new config key, `retention.maxLogFiles` (default 30), bounds how many daily daemon log files
  are kept on disk; applied at daemon startup and on `crontick daemon reload`.
- Dashboard/stats average run duration no longer counts `missed`, `queued`, `running`, or
  `canceled` runs -- only runs that actually finished executing (`success`, `failed`, `timeout`).
