# Internals document skeleton

Use this as guidance when creating a new `docs/internals/*.md` file.

## Structure

```markdown
# <Module/subsystem name> internals

## Purpose

What this module does and why it exists.

## Key files

| File | Responsibility |
|------|---------------|
| `src/path/file.ts` | <what it does> |

## Data structures

Describe internal data shapes, storage formats, or state machines.

## Control flow

Describe the main execution paths through this module.

## Invariants

List assumptions that must hold for correctness.

## Error handling

How errors propagate within this module and to callers.

## Extension points

Where and how this module can be extended (if applicable).
```

## Rules

- Answers "how is this implemented?"
- For maintainers and coding agents, not end users.
- Always cite `src/` paths.
- Do not repeat user-facing descriptions (link to concepts/reference instead).
- Keep current with source -- delete content that no longer matches code.
