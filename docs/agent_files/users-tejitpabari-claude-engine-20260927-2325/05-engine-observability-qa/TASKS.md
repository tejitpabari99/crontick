---
status: draft
summary: Four tasks - shared job-log path helper plus logFile payload, display-only usage normalizer, eval-free SessionEnd hook helper with shortened stored command, then tests/docs/changeset.
date: 2026-10-01
---
# Tasks: Engine observability Q&A (SP05)
Source of truth: docs/agent_files/users-tejitpabari-claude-engine-20260927-2325/05-engine-observability-qa/PRD.md. The Q&A answers themselves live in the PRD; these tasks implement only its code decisions. Consumers: SP03 (stats, `runs get`) and SP04 (dashboard) use Task 1 and Task 2 outputs; no DB schema or storage change.

| # | Task | Depends on | Status |
|---|---|---|---|
| 1 | Job log path helper and `logFile` in run payload | - | done |
| 2 | Display-only `normalizeUsage` | - | done |
| 3 | Eval-free SessionEnd hook helper and shortened command | - | done |
| 4 | Tests, docs, reference, specs, changeset | 1-3 | todo |

## Task 1 — Job log path helper and `logFile` in run payload
What it is / what it means: No shared function returns the per-job log file location today; SP03 and SP04 both need it (Decision 1).
What changes at a high level: Export a path resolver from the job-log-file module that returns the absolute per-job mirror path, reusing the existing safe-file-name logic and logging config resolution, and null when file logging is disabled. Have the daemon include a nullable absolute `logFile` in the run get payload. Behavior of the log writer itself is untouched; the store stays the source of truth for per-run logs.
Done when: The helper returns an absolute path with config dir override honored and null when file logging is off; the run get payload exposes `logFile`.

## Task 2 — Display-only `normalizeUsage`
What it is / what it means: Claude's raw `usageJson` stays stored as-is; display surfaces need a stable shape (Decisions 2, 3).
What changes at a high level: Add a pure normalizer in the run-output module mapping the raw usage object to input, output, cache-read, cache-creation and optional thinking token counts, ignoring `iterations`, returning undefined for missing or non-numeric fields and for non-object input. Wire it only into display paths (run output result, available to CLI/dashboard consumers); storage and schema do not change.
Done when: Unit tests cover the sample usage object, missing thinking tokens, and non-object input; stored `usageJson` is byte-identical to before.

## Task 3 — Eval-free SessionEnd hook helper and shortened command
What it is / what it means: The Claude adapter's base64 `eval` hook is opaque; replace it with a readable helper script and stop storing the large settings blob (Decisions 4, 5).
What changes at a high level: At daemon start, idempotently write a fixed-content helper script under the data dir's hooks folder (private permissions, no embedded paths) that reads the hook JSON from stdin and writes the completion marker, taking the marker path as an argument; also write it from the invocation builder as a fallback. The hook command becomes the node executable, the helper and the marker path, double-quoted, with POSIX single-quote escaping as today. If the helper cannot be written, or the data dir contains unsafe characters (quote, dollar), omit `--settings` entirely and let the run proceed. Marker format and its consumers (startup reconcile, adopted-run poll) are unchanged. In the runner, replace the `--settings` value with a `<session-end-hook>` placeholder in the stored command and in the diagnostic log lines.
Done when: No `eval(` in the engines directory and no base64 in generated commands; marker is produced through the helper on Linux and with a Windows-style quoted path; missing helper yields no `--settings` and a successful run; stored command shows the placeholder.

## Task 4 — Tests, docs, reference, specs, changeset
What it is / what it means: Close out per AGENTS.md rules.
What changes at a high level: Add any tests not covered above (hook helper idempotency, command redaction, `logFile` payload). Update `docs/reference/` for `logFile` and usage normalization, the engine/runner implementation docs and relevant `docs/specs/` entries for the hook change and per-job log file semantics, and record the Q&A conclusions (log source, cost origin, hook purpose, turns definition) where the PRD says they belong. Add a changeset (minor, pre-1.0). Run `npm run validate`.
Done when: `npm run validate` passes, docs updated, changeset present.
