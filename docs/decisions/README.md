# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for crontick. An ADR
captures a single significant technical decision: its context, the choice made, the
alternatives evaluated, and the consequences (positive and negative).

## When to write a new ADR

Write a new ADR when:

- Introducing a new dependency that shapes the architecture.
- Changing the project structure, build pipeline, or module boundaries.
- Choosing between two or more viable approaches where the trade-offs are non-obvious.
- Reversing or superseding a previous decision.

Do NOT write an ADR for routine implementation choices (variable naming, refactoring
within an existing module, bug fixes that do not alter architecture).

## When to edit an existing ADR

Never change the substance of an accepted ADR. If a decision is reversed, write a new
ADR that supersedes it and update the old ADR's status line to
`Superseded by ADR-NNNN`.

You may fix typos or add clarifying links without changing meaning.

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
| 0001 | Single-core / thin-shim architecture | Accepted | 2026-07-25 |
| 0002 | Publish as ESM-only package | Accepted | 2026-07-25 |
| 0003 | Demand-started local daemon instead of OS service | Accepted | 2026-07-25 |
| 0004 | Loopback-only HTTP as daemon IPC transport | Accepted | 2026-07-18 |
| 0005 | SQLite WAL plus JSON files for state persistence | Accepted | 2026-07-18 |
| 0006 | Use croner as the cron expression engine | Accepted | 2026-07-18 |
| 0007 | Use zod for schema validation at every surface boundary | Accepted | 2026-07-18 |
| 0008 | Introduce prompt jobs with pluggable prompt engines | Accepted | 2026-07-25 |
| 0009 | Use changesets for versioning and releases | Accepted | 2026-07-18 |
| 0010 | Use tsup as the build tool | Accepted | 2026-07-18 |
| 0011 | Use vitest as the test runner with surface-drift as architectural test | Accepted | 2026-07-18 |
| 0012 | Cap run history per job with count-based, best-effort, batched eviction | Accepted | 2026-07-26 |
| 0013 | Narrow the autostart-removal guard test to shipped product surfaces only | Accepted | 2026-07-26 |
| 0014 | HTTP-based graceful shutdown, with signals as a POSIX-only fallback | Accepted | 2026-07-26 |
| 0015 | Report missed fires as records, never replay them | Accepted | 2026-07-26 |
| 0016 | Spawn every job process detached, identically on every platform | Superseded by ADR-0020 | 2026-07-26 |
| 0017 | No migration framework for the v1.0.0 schema | Accepted | 2026-07-26 |
| 0018 | `--exec` takes command and args verbatim, separated by `--` | Superseded by ADR-0019, ADR-0028 | 2026-07-26 |
| 0019 | `--arg` is the primary way to pass arguments to `--exec`/`--prompt` | Accepted; partially superseded by ADR-0028 | 2026-07-27 |
| 0020 | Do not detach pwsh/powershell.exe script jobs on Windows | Accepted; superseded by ADR-0028 | 2026-07-27 |
| 0021 | Duplicate job create requires explicit force | Accepted | 2026-07-28 |
| 0022 | Keep secret redaction as one shared streaming contract | Accepted | 2026-07-30 |
| 0023 | Prefer precision over recall for AWS secret redaction | Accepted | 2026-07-31 |
| 0024 | Reorganize CLI commands and narrow high-risk exposure | Accepted | 2026-08-02 |
| 0025 | GUID job identity with an optional human-friendly alias | Accepted | 2026-08-02 |
| 0026 | Simplify round-2 commands by folding admin reads into info | Accepted | 2026-08-03 |
| 0027 | Remove pre-production migration, legacy, and back-compatibility code | Accepted | 2026-08-03 |
| 0028 | crontick becomes prompt-only; remove `script`/`exec` action kinds and the Copilot plugin | Accepted | 2026-09-27 |
| 0029 | Distinguish overlap skips and protect reused sessions | Accepted | 2026-09-28 |
