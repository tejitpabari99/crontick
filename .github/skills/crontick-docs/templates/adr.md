# ADR template

The authoritative ADR template lives at `docs/decisions/0000-template.md`.
Use that file directly when creating new ADRs. This file exists only as a pointer.

## Quick reference

```
# NNNN: <Short imperative title>

- Status: Proposed | Accepted | Superseded by ADR-NNNN | Deprecated
- Date: YYYY-MM-DD

## Context
## Decision
## Alternatives considered
## Consequences
## Revisit when
```

## Rules

- One decision per file.
- File naming: `NNNN-kebab-title.md`, contiguous numbering.
- Consequences MUST include real downsides.
- When a new ADR reverses an earlier one, update the old ADR's status to
  "Superseded by ADR-NNNN".
