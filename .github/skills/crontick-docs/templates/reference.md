# Reference document skeleton

Use this as guidance when creating a new `docs/reference/*.md` file.

## Structure

```markdown
# <Subject> reference

## Overview

One sentence stating what this reference covers.

## <Item 1>

### Syntax / Signature

Exact usage, flags, parameters.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| | | | |

### Returns / Output

What the user gets back.

### Errors

| Code | Condition | Resolution |
|------|-----------|------------|
| | | |

### Examples

Minimal usage example (link to `examples/` for full runnable versions).

## <Item 2>

(repeat structure)
```

## Rules

- Answers "what exactly is supported?"
- Precise, factual, lookup-oriented.
- Exact inputs, outputs, defaults, errors, supported values.
- No storytelling, no philosophy, no "why" (that belongs in concepts or decisions).
- Every fact must be verifiable against source code.
- Keep alphabetical or logical grouping consistent within each file.
