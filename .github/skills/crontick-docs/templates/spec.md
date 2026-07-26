# Spec template

The authoritative spec template lives at `specs/TEMPLATE.md`.
Use that file directly when creating new specs. This file exists only as a pointer.

## Quick reference

```
# NNN: <Feature name>

- Status: Draft | Active | Deprecated
- Owner: crontick maintainers
- Last reviewed: YYYY-MM-DD

## Summary
## Motivation
## Terminology
## Requirements
### Functional requirements
- **R-NNN-1**: <Subject> MUST <behavior>.
### Non-functional requirements
## Behavior
## Inputs and outputs
## Edge cases and failure modes
## Acceptance criteria
- [ ] <Criterion> (test file: `tests/<file>.test.ts`)
## Out of scope
## Open questions
## Related
```

## Rules

- Numbered requirements use RFC 2119 keywords (MUST, SHOULD, MAY).
- Requirement IDs are stable: `R-NNN-N` where NNN matches the spec number.
- Acceptance criteria cite real test files with honest unchecked gaps.
- File naming: `NNN-kebab-title.md`, contiguous numbering.
