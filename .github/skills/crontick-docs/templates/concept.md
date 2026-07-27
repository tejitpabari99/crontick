# Concept document skeleton

Use this as guidance when creating a new `docs/concepts/*.md` file.

## Structure

```markdown
# <Concept name>

One-paragraph summary of the mental model.

## The model

Explain how a user or contributor should think about this concept.
Focus on behavior that crosses component boundaries.
Do not tie explanations to a single source file.

## How it interacts with other concepts

Describe relationships to other concepts (link to their docs).

## Common misconceptions

List things people get wrong and the correct understanding.

## Further reading

- Link to relevant reference docs for precise details.
- Link to relevant internals docs for implementation.
- Link to relevant specs for normative behavior.
```

## Rules

- Answers "how should I think about this?"
- Crosses components -- not tied to one file.
- No exhaustive tables (those belong in reference docs).
- No implementation details (those belong in internals docs).
- No precise flag/option syntax (those belong in reference docs).
