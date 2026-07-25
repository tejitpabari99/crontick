# Specifications

This directory contains the normative behavior-level contracts for crontick features.
Specs are the reference for coding agents implementing changes, and for reviewers
verifying correctness.

## Audience

- Contributors implementing or modifying features.
- Coding agents (LLMs) that read a spec before editing the relevant source.
- Reviewers checking that a change conforms to the contract.

## Spec lifecycle

Each spec has a `Status` field in its frontmatter:

| Status | Meaning |
|--------|---------|
| `Draft` | Under development; not yet normative. |
| `Active` | Normative; code MUST conform to this spec. |
| `Superseded` | Replaced by a newer spec; retained for history. |

## Rules

1. When public behavior changes, the relevant spec MUST be updated in the same
   change (PR/commit).
2. Every requirement uses RFC 2119 keywords (MUST, MUST NOT, SHOULD, MAY).
3. Every requirement has a stable ID of the form `R-NNN-N` where `NNN` is the spec
   number and `N` is the requirement sequence within that spec.

## Naming convention

Files are named `NNN-kebab-feature-name.md` where `NNN` is a zero-padded three-digit
number assigned in order of creation.

## Index

| ID | Title | Status | Scope |
|----|-------|--------|-------|
| 001 | [Job Definition](001-job-definition.md) | Active | Job identity, kinds, validation, mutation |
| 002 | [Scheduling](002-scheduling.md) | Active | Cron, interval, one-shot; next-run; timezone |
| 003 | [Execution](003-execution.md) | Active | Run lifecycle, spawn, output, timeout, overlap |
| 004 | [Daemon](004-daemon.md) | Active | Daemon lifecycle, HTTP API, recovery |
| 005 | [Surface Parity](005-surface-parity.md) | Active | CLI/MCP/API parity enforcement |
| 006 | [State and Persistence](006-state-and-persistence.md) | Active | Durability, layout, retention, upgrades |
| 007 | [Prompt Jobs](007-prompt-jobs.md) | Active | Prompt engines, invocation, session capture |

## Template

See [TEMPLATE.md](TEMPLATE.md) for the blank spec structure.

## Related

- `../docs/reference/` -- user-facing reference material (exact facts).
- `../docs/internals/` -- implementation explanations.
- `../docs/concepts/` -- conceptual guides.
