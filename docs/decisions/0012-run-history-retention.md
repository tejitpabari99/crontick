# 0012: Cap run history per job with count-based, best-effort, batched eviction

- Status: Accepted
- Date: 2026-07-26

## Context

Before this decision, `runs` and `run_logs` grew without bound: every job execution added a
row (and one or more log rows) that was never removed. For a job on a short interval, or a
long-lived install, this meant `runs.db` grew indefinitely, with no supported way to reclaim
space short of manually deleting the database file (losing all history, not just old history).

`docs/concepts/state-and-storage.md` documented this as a known limitation ("no automatic
purging... use `runs.db` size or row count as an indicator of when manual cleanup is needed").
This ADR records the decision to close that gap with an automatic, per-job retention cap.

## Decision

Add a per-job count cap, `retention.maxRunsPerJob` (default `100`, bounds `1..100000`,
`RetentionConfigSchema` in `src/schemas/config.ts`). Behavior:

- Only **terminal** runs (`status NOT IN ('running', 'queued')`) are eviction candidates; a run
  that is currently active is never evicted regardless of age.
- Within the terminal set, the **oldest runs are evicted first** (`ORDER BY started_at ASC,
  rowid ASC`), until the job's terminal-run count is back at or below the cap.
- Eviction is **best-effort**: `Store.insertRun()` prunes the affected job's history in a
  try/catch, and a startup backfill (`pruneAllJobsRunHistory()`) sweeps every job on daemon
  boot for databases that grew past the cap under an earlier version (or after the cap was
  lowered). Neither ever fails the run insert or blocks daemon startup; failures are logged.
- Deletes happen in **transactional batches of 500 ids** (`EVICTION_BATCH_SIZE` in
  `src/daemon/store.ts`) rather than one unbounded statement, because `node:sqlite` rejects
  more than 32766 bound parameters per statement and an unbatched delete could itself fail (or
  hold a long-lived transaction) on a large backlog -- exactly the case the backfill exists to
  fix. `run_logs` for an evicted run are deleted before the `runs` row in the same transaction.
- The cap is **re-read on `crontick daemon reload`** (`Store.setRunRetentionCap()`), so an
  operator can change it without restarting the daemon.
- The composite index `idx_runs_job_id_started_at` on `(job_id, started_at)` (created directly
  in the schema; there is no separate migration step -- see ADR 0017) supports the eviction
  query's ordered walk without a scan-then-sort.

See [internals/storage.md](../internals/storage.md) for the full algorithm and
[reference/configuration.md](../reference/configuration.md) for the config surface.

## Alternatives considered

**Age-based retention (e.g. "keep 30 days").** Rejected as the default because it does not
bound worst-case storage for a high-frequency job (a job ticking every second for 30 days is
unbounded in row count), and it requires a wall-clock notion of "now" that complicates
best-effort pruning during a backfill of historical data. A count cap bounds storage
deterministically regardless of schedule frequency. Age-based retention could be added later
as an additional, independent constraint (see Revisit when).

**Byte/size-based retention (e.g. "keep runs.db under 100 MB").** Rejected as the default:
requires either a running total that can drift from `PRAGMA page_count`-derived reality, or an
expensive on-demand size computation before every insert. It also does not compose cleanly with
the per-job model without either estimating average row size or accepting cross-job unfairness
(one job's oversized runs starving another job's retained history).

**No cap; document manual cleanup instructions instead.** Rejected: this was the status quo
this ADR replaces, and it requires every operator to notice unbounded growth themselves; a
demand-started local daemon has no operator watching it.

**Fail the run insert if pruning fails.** Rejected: retention is maintenance, not correctness.
Coupling it to the insert path would mean a transient pruning failure (e.g. disk I/O error)
could stop new runs from being recorded at all, which is a worse outcome than temporarily
exceeding the cap.

**One unbounded `DELETE ... WHERE id IN (...)` per prune.** Rejected: bound-parameter limits in
`node:sqlite` (`SQLITE_LIMIT_VARIABLE_NUMBER`, ~32766) make this fail outright on any job whose
backlog exceeds that many terminal runs -- precisely the backlog the startup backfill exists to
clear, which would make the daemon permanently unable to start for that job's data. Batching in
groups of 500 also bounds how long any single transaction holds the tables.

## Consequences

**Easier:**

- `runs.db` growth is now bounded per job by default; no manual cleanup is required for normal
  operation.
- The cap is adjustable per install via `config.json`, and takes effect live via reload.
- Databases from before this feature (or with a since-lowered cap) self-heal on next daemon
  start via the backfill.

**Harder:**

- Diagnosing "why is my run gone" now requires knowing about the cap; documented in
  [state-and-storage.md](../concepts/state-and-storage.md#run-history-retention) and
  [troubleshooting.md](../troubleshooting.md#my-old-runs-disappeared).

**Impossible (by design, honestly recorded, not hidden):**

- **No age-based or byte-based cap on run *count*.** A job that fires every minute keeps
  roughly 100 minutes of history under the default cap; a job that fires monthly keeps years.
  There is no way to say "keep 30 days regardless of frequency" today. (A single run's captured
  *output* size is bounded independently -- see `retention.maxOutputBytesPerRun` in
  [reference/configuration.md](../reference/configuration.md) -- but that is an orthogonal cap,
  not a substitute for age-based run retention.)
- **No automatic export, warning, or undo before eviction.** Eviction is a hard delete inside
  the daemon; there is no built-in prompt or automatic backup at the moment a run is pruned, and
  no notification is emitted beyond a debug-level log line. The available mitigation is
  operator-initiated: `crontick export --include-runs` (and the corresponding `import`) lets an
  operator snapshot run history before it ages out of the cap, but nothing does this
  automatically or on a schedule.
- **Eviction can temporarily let a job exceed the cap** by the number of currently-active runs,
  since active runs are never evicted; this is intentional (never delete in-flight state) but
  means the cap is not a hard ceiling on total row count at every instant.

## Revisit when

- A user needs age-based retention (e.g. compliance requiring "no run data older than N days")
  in addition to, or instead of, the count cap -- this would be an additive
  `retention.maxAgeDays`-style field, not a replacement for the count cap.
- Users request an automatic export-before-delete or dry-run mode; this was consciously
  deferred to keep eviction simple. `crontick export --include-runs` covers the manual case
  today; an automatic variant (e.g. "always snapshot the last N runs before evicting them")
  would be a separate, later decision.
