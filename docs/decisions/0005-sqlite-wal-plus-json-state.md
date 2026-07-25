# 0005: SQLite WAL plus JSON files for state persistence

- Status: Accepted
- Date: 2026-07-18

## Context

crontick must persist two kinds of data:

1. **Job definitions** -- the user's intent (schedule, action, overlap policy).
2. **Run history** -- timestamped execution records with stdout/stderr logs.

Job definitions are edited by humans (imported, exported, version-controlled). Run
history is append-heavy, query-heavy, and disposable. These access patterns suggest
different storage strategies.

## Decision

Use a hybrid approach:

- **Job definitions** are individual JSON files in `<dataDir>/jobs/<id>.json`, each
  accompanied by a `<id>.schema.json` sidecar for editor tooling. Jobs are the source of
  truth for what is scheduled.
- **Run history and logs** live in a SQLite database (`<dataDir>/runs.db`) using WAL
  journal mode for concurrent read/write from a single daemon process.
- **Data directory location** is resolved via the `env-paths` package (v3), yielding
  platform-idiomatic paths (`%LOCALAPPDATA%\crontick` on Windows,
  `~/.local/share/crontick` on Linux, `~/Library/Application Support/crontick` on macOS).
  Overridable with `CRONTICK_HOME`.
- SQLite is the Node.js built-in `node:sqlite` (available since Node 22.5; shim flag
  `--experimental-sqlite` on Node < 24).

## Alternatives considered

**SQLite for everything.** Store jobs as rows. Simpler single-file backup, but:

- Loses human-readable per-job files (harder to diff, export, or version-control).
- Requires custom tooling to inspect a single job's definition.
- JSON file approach enables `crontick export/import` to be trivial file copies.

**JSON-only (no SQLite).** Store runs as JSON files or NDJSON. Feasible for small
workloads, but:

- Querying "last 10 runs for job X" requires scanning all run files.
- Append-heavy log capture into flat files lacks indexing.
- No transactional guarantees for concurrent writes.

**LevelDB / LMDB / embedded key-value store.** Adds a native addon dependency, which
complicates `npm install -g` across platforms. Node.js built-in SQLite avoids this.

**External database (Postgres, Redis).** Overkill for a local developer tool; adds
deployment complexity and a network dependency.

## Consequences

**Easier:**

- Job files are human-readable, diffable, and trivially portable (`crontick export`
  zips them; `import` unzips).
- SQLite WAL provides fast appends for run logs without blocking reads.
- No native addons to compile -- `node:sqlite` ships with Node.js.
- Schema migrations are simple sequential SQL scripts in `src/daemon/store.ts`.

**Harder:**

- Two storage subsystems to reason about (file system + SQLite).
- Job file writes are not atomic on all filesystems; a crash mid-write could corrupt a
  single job file (mitigated by write-then-rename in `Store.upsertJob`).
- The `node:sqlite` API is still relatively new; documentation and community tooling are
  less mature than packages like `better-sqlite3`.

**Impossible:**

- Multi-process concurrent writes to the same runs.db (single daemon design makes this
  moot).

## Revisit when

- `node:sqlite` is deprecated or removed from Node.js core (unlikely but possible).
- Job count exceeds thousands and file-per-job directory scanning becomes a bottleneck.
- A requirement emerges for multi-daemon clustering with shared state.
