# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for crontick. An ADR
captures a single significant, lasting technical decision: its context, the choice made,
the alternatives evaluated, and the consequences (positive and negative).

crontick's ADR set was consolidated on 2026-09-28 from 33 individually-numbered records
(most of them auto-created, one per incremental change) down to 3 that each cover one
major, still-current area of the design. See "History and mapping" below if you are
looking for a specific old ADR number cited elsewhere (source comments, tests, the
changelog).

## When to write a new ADR

Write a new ADR only for a decision that is major and lasting: something that shapes the
architecture, changes a module boundary or public surface, introduces a dependency that
constrains future choices, or reverses a previous major decision. Do NOT write an ADR
for a routine implementation choice, a bug fix, a CLI flag rename, or an incremental
refinement of an already-recorded decision.

When a change refines, narrows, or partially reverses a decision already covered by an
existing ADR, **update that ADR in place** (edit its Decision/Consequences sections,
update its Date, and note what changed and why) rather than creating a new numbered ADR
for it. Reserve a genuinely new ADR number for a decision that does not fit under any
existing ADR's scope. This keeps the set small on purpose -- prefer editing ADR 0001,
0002, or 0003 over adding ADR 0004 for something that is really a refinement of one of
them.

## File naming convention

```
NNNN-kebab-case-title.md
```

- Numbers are zero-padded to 4 digits, sequential, never reused.
- `0000-template.md` is the blank template for new ADRs.

## Allowed status values

| Status | Meaning |
|--------|---------|
| `Proposed` | Under discussion; not yet accepted. |
| `Accepted` | Active and in effect. |
| `Superseded by ADR-NNNN` | Replaced by a newer decision. |
| `Deprecated` | No longer relevant (e.g., feature removed entirely). |

## Index

| # | Title | Status | Date |
|---|-------|--------|------|
| [0001](0001-architecture-and-runtime-model.md) | Architecture and runtime model | Accepted | 2026-10-09 |
| [0002](0002-prompt-only-jobs-and-engine-adapters.md) | Prompt-only jobs and the engine adapter framework | Accepted | 2026-09-28 |
| [0003](0003-toolchain-and-distribution.md) | Toolchain and distribution | Accepted | 2026-10-01 |
| [0004](0004-config-writes-file-direct-and-pause.md) | File-direct config writes, and pause vs stop | Accepted | 2026-10-09 |

## History and mapping

The table below maps every pre-consolidation ADR number to the new ADR that absorbs it,
so a historical reference (an old commit message, a changeset, `CHANGELOG.md`) naming an
old number stays resolvable. The old files themselves are deleted -- this table, not the
files, is the historical record.

| Old # | Old title | Absorbed into |
|---|---|---|
| 0001 | Single-core / thin-shim architecture | [0001](0001-architecture-and-runtime-model.md) |
| 0002 | Publish as ESM-only package | [0003](0003-toolchain-and-distribution.md) |
| 0003 | Demand-started local daemon instead of OS service | [0001](0001-architecture-and-runtime-model.md) |
| 0004 | Loopback-only HTTP as daemon IPC transport | [0001](0001-architecture-and-runtime-model.md) |
| 0005 | SQLite WAL plus JSON files for state persistence | [0001](0001-architecture-and-runtime-model.md) |
| 0006 | Use croner as the cron expression engine | [0003](0003-toolchain-and-distribution.md) |
| 0007 | Use zod for schema validation at every surface boundary | [0003](0003-toolchain-and-distribution.md) |
| 0008 | Introduce prompt jobs with pluggable prompt engines | [0002](0002-prompt-only-jobs-and-engine-adapters.md) |
| 0009 | Use changesets for versioning and releases | [0003](0003-toolchain-and-distribution.md) |
| 0010 | Use tsup as the build tool | [0003](0003-toolchain-and-distribution.md) |
| 0011 | Use vitest as the test runner with surface-drift as architectural test | [0001](0001-architecture-and-runtime-model.md) (surface-drift) / [0003](0003-toolchain-and-distribution.md) (vitest) |
| 0012 | Cap run history per job with count-based, best-effort, batched eviction | [0001](0001-architecture-and-runtime-model.md) |
| 0013 | Narrow the autostart-removal guard test to shipped product surfaces only | [0001](0001-architecture-and-runtime-model.md) |
| 0014 | HTTP-based graceful shutdown, with signals as a POSIX-only fallback | [0001](0001-architecture-and-runtime-model.md) |
| 0015 | Report missed fires as records, never replay them | [0001](0001-architecture-and-runtime-model.md) |
| 0016 | Spawn every job process detached, identically on every platform | [0001](0001-architecture-and-runtime-model.md) |
| 0017 | No migration framework for the v1.0.0 schema | [0001](0001-architecture-and-runtime-model.md) |
| 0018 | `--exec` takes command and args verbatim, separated by `--` | [0002](0002-prompt-only-jobs-and-engine-adapters.md) (obsolete: `exec` removed) |
| 0019 | `--arg` is the primary way to pass arguments to `--exec`/`--prompt` | [0002](0002-prompt-only-jobs-and-engine-adapters.md) |
| 0020 | Do not detach pwsh/powershell.exe script jobs on Windows | [0001](0001-architecture-and-runtime-model.md) (generic detached exception; the `script`-specific wrapper it originally applied to is obsolete) |
| 0021 | Duplicate job create requires explicit force | [0002](0002-prompt-only-jobs-and-engine-adapters.md) |
| 0022 | Keep secret redaction as one shared streaming contract | [0001](0001-architecture-and-runtime-model.md) |
| 0023 | Prefer precision over recall for AWS secret redaction | [0001](0001-architecture-and-runtime-model.md) |
| 0024 | Reorganize CLI commands and narrow high-risk exposure | [0001](0001-architecture-and-runtime-model.md) |
| 0025 | GUID job identity with an optional human-friendly alias | [0002](0002-prompt-only-jobs-and-engine-adapters.md) |
| 0026 | Simplify round-2 commands by folding admin reads into info | [0001](0001-architecture-and-runtime-model.md) |
| 0027 | Remove pre-production migration, legacy, and back-compatibility code | [0001](0001-architecture-and-runtime-model.md) |
| 0028 | crontick becomes prompt-only; remove `script`/`exec` action kinds and the Copilot plugin | [0002](0002-prompt-only-jobs-and-engine-adapters.md) |
| 0029 | Distinguish overlap skips and protect reused sessions | [0002](0002-prompt-only-jobs-and-engine-adapters.md) |
| 0030 | Forward unknown long options to prompt engines | [0002](0002-prompt-only-jobs-and-engine-adapters.md) |
| 0031 | Rename job CLI flags to alias and runner | [0002](0002-prompt-only-jobs-and-engine-adapters.md) |
| 0032 | Use Claude completion markers only for restart recovery | [0002](0002-prompt-only-jobs-and-engine-adapters.md) |
| 0033 | Select prompt behavior through engine adapters | [0002](0002-prompt-only-jobs-and-engine-adapters.md) |
| 0034 | Opt-in login autostart through a platform backend (Linux systemd `--user`, macOS launchd, Windows Task Scheduler) | [0001](0001-architecture-and-runtime-model.md) (section "OS autostart (ADR 0034)") |
| 0035 | `after` trigger: shared non-time trigger dispatch from the run-completion hook, no replay of completions missed during downtime | [0001](0001-architecture-and-runtime-model.md) (section "Trigger dispatch for non-time schedules (ADR 0035)") |

Tooling notes and dependency-specific rejected alternatives from the pre-consolidation
ADRs (e.g. `cron-parser` vs. `croner`, `ajv` vs. `zod`) live in the new ADRs' own
"Alternatives considered" sections where still relevant; content that was purely
historical or already obsolete before this consolidation (e.g. the `--exec`/PowerShell
script-job specifics superseded by the prompt-only pivot) was dropped rather than
carried forward.
