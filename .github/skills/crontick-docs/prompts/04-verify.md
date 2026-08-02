# Step 4: Verify

## Objective

Confirm all documentation changes are accurate, linked correctly, non-duplicative, and
pass validation.

## Checks (in order)

### 1. Accuracy check

For each edit applied in Step 3, re-read the source file and confirm:
- Identifiers match exactly (case-sensitive).
- Default values match exactly.
- Parameter names and types match exactly.
- Behavioral descriptions match the implementation, not aspirational intent.

If any discrepancy is found, fix it immediately.

### 2. Link check

Run:
```powershell
node .github/skills/crontick-docs/scripts/check-links.mjs
```

Fix any broken links reported. Re-run until clean.

### 3. Inventory check

Run:
```powershell
node .github/skills/crontick-docs/scripts/doc-inventory.mjs
```

If any doc files exist that are not indexed in `docs/README.md`, add them.
If any indexed files do not exist on disk, remove them from the index.

### 4. Duplication check

Manually verify these common duplication vectors:
- `AGENTS.md` does not repeat content from `docs/reference/` or `docs/architecture.md`.
- `README.md` does not duplicate the full reference -- it summarizes and links.
- `CLAUDE.md` does not copy `AGENTS.md` -- it imports via `@AGENTS.md`.
- No concept doc repeats tables that belong in reference docs.
- No internals doc repeats user-facing descriptions that belong in concepts.

### 5. Guard test

Run:
```powershell
npx vitest run tests/autostart-removal.test.ts --reporter=verbose
```

If it fails, you have reintroduced a removed-feature string. Find and remove it.

### 6. Full validation

Run:
```powershell
npm run validate
```

This runs: lint, typecheck, typecheck:examples, test, build. All must pass.

### 7. Removed-content sweep

If any feature, command, or flag was removed in the diff:
- Grep for its name across `docs/`, `docs/specs/`, `examples/`, `README.md`, `AGENTS.md`.
- Remove any remaining references.

## Output

Produce a verification summary:

```markdown
## Verification results

| Check | Status | Notes |
|-------|--------|-------|
| Accuracy | PASS | All 5 edits verified against source |
| Links | PASS | 0 broken links |
| Inventory | PASS | docs/README.md matches tree |
| Duplication | PASS | No duplicates found |
| Guard test | PASS | autostart-removal.test.ts green |
| Full validate | PASS | lint + typecheck + test + build clean |
| Removed content | N/A | No removals in this change |
```

Pass any failures and their resolution to the report.
