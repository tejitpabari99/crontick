# Step 3: Apply documentation updates

## Objective

Execute the update plan from Step 2, honoring the documentation layering contract.

## The layering contract

Each fact lives in EXACTLY ONE place. Never duplicate across layers.

| Location | Answers | Rule |
|---|---|---|
| `docs/architecture.md` | High-level design | ONE file. Fixed section order: Purpose / Scope and non-goals / Public API boundary / Major components / Control and data flow / Important invariants / Error model / Extension points / Dependency policy / Performance considerations / Compatibility requirements / Security considerations. Must contain what cannot be inferred from filenames. Never a directory listing. |
| `docs/concepts/*.md` | "How should I think about this?" | Mental model and behavior that crosses components. Not tied to one file. No exhaustive tables. |
| `docs/internals/*.md` | "How is this implemented?" | Private implementation, for maintainers and coding agents. Cite `src/` paths. |
| `docs/reference/*.md` | "What exactly is supported?" | Precise, factual, lookup-oriented. Exact inputs, outputs, defaults, errors, supported values. No storytelling, no philosophy. |
| `docs/decisions/*.md` | "Why is it like this?" | ADRs, one decision per file, `NNNN-kebab-title.md`, contiguous numbering. Template: `docs/decisions/0000-template.md`. Statuses: Proposed / Accepted / Superseded by ADR-NNNN / Deprecated. Consequences must include real downsides. |
| `docs/specs/*.md` | Normative behavior contract | Numbered requirements with RFC 2119 keywords and stable IDs; acceptance criteria as a checklist citing real test files. Template: `docs/specs/TEMPLATE.md`. |
| `docs/testing.md` | How to test | Includes manual pre-release checklist. |
| `examples/` | Runnable public-API usage | Public imports only; must pass `npm run typecheck:examples` and `npm run lint`. |
| `README.md` | User entry point | Fixed section order; answers within a minute: problem, install, example, environments, public API, issues. |
| `AGENTS.md` | Tool-neutral agent contract | Commands, boundaries, non-obvious rules, completion criteria ONLY. References docs -- never duplicates them. Excludes dependency lists, generated trees, tutorials, historical decisions, vague advice. |
| `CLAUDE.md` | Claude entry point | `@AGENTS.md` import plus Claude-specific bullets. Never a copy. |
| `.github/copilot-instructions.md` | Copilot entry point | Short; points at `AGENTS.md`; no repetition. |

## Standing rules

- SOURCE CODE always wins when a doc and code disagree.
- Verify every identifier, flag, tool name, default, and path against real source before writing.
- No legacy or aspirational docs: if content no longer matches code, delete it.
- No emoji, no marketing language, no filler.
- Every relative link must resolve.
- Guard test `tests/autostart-removal.test.ts` fails if removed-feature strings reappear.

## Procedure for each planned update

For each item in the update plan:

1. **Read the source** -- open the source file cited in the verification column. Extract
   the exact names, signatures, defaults, and behaviors.

2. **Read the target doc** -- open the doc file to understand current structure and
   surrounding content.

3. **Apply the edit** -- modify only the relevant section. Preserve existing structure.
   Match the tone and level of detail of surrounding content.

4. **Cross-check layering** -- after editing, verify the same fact does not also appear in
   another layer. If it does, remove the duplicate and replace with a cross-reference.

5. **Check links** -- ensure any new relative links point to real files.

## When creating new files

- **New ADR**: Use `docs/decisions/0000-template.md` as the template. Assign the next
  contiguous number. Set status to "Accepted" (or "Proposed" if not yet merged).
- **New spec**: Use `docs/specs/TEMPLATE.md` as the template. Assign the next contiguous number.
- **New concept doc**: Use `templates/concept.md` as skeleton guidance, but the canonical
  structure comes from existing `docs/concepts/*.md` files.
- **New internals doc**: Use `templates/internals.md` as skeleton guidance.
- **New reference doc**: Use `templates/reference.md` as skeleton guidance.

After creating any new file, add it to `docs/README.md` in the Full Index section.

## When deleting content

- If a feature, flag, command, or error code was removed from source, remove its
  documentation entirely. Do not leave "deprecated" stubs unless the removal is phased.
- Update `docs/README.md` index if a file was deleted.
- Check that no other doc has a now-broken link to removed content.

## Output

After completing all edits, produce a checklist:

```markdown
## Edits applied

- [x] `docs/reference/cli.md`: added stats command section
- [x] `README.md`: updated capability count to 37
- [ ] `docs/reference/mcp-tools.md`: SKIPPED -- tool not yet registered in source
```

Pass any skipped items and their reasons to Step 4.
