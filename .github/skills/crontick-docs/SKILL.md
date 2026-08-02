---
name: crontick-docs
description: "Update crontick documentation after code changes. Use when syncing docs with a commit range, documenting a new feature, refreshing docs before a release, or verifying doc accuracy against current source. Accepts a commit SHA/range, a PR number, or defaults to uncommitted work."
---

# crontick-docs

Update crontick's documentation so it stays accurate, consistently structured, and
non-duplicative after any code change.

## When to use

- After any code change that alters observable behavior, public API surface, CLI flags,
  MCP tools, configuration, error codes, or internal architecture.
- Before a release, to sweep uncommitted work for undocumented changes.
- When the owner explicitly asks to "sync docs" or "document this feature".

## When NOT to use

- Formatting-only changes to docs (no code trigger).
- Dependency-only bumps with no code, API, or behavioral change.
- Changes exclusively to `tests/` that do not alter acceptance criteria in specs.

## Inputs

The owner specifies scope in one of these forms:

| Input | How to resolve the diff |
|-------|------------------------|
| Commit SHA or range | `git --no-pager diff <ref>...HEAD --stat` then full diff |
| PR number | `gh pr diff <n> --repo tejitpabari99/crontick` |
| "current work" / nothing | `git --no-pager diff HEAD` (uncommitted), falling back to `git --no-pager diff HEAD~1...HEAD` (last commit) if working tree is clean |

Always resolve to a file-level stat first, then read full diffs only for files that
trigger documentation updates per the routing table.

## Workflow

Execute these steps in order. Each step references a prompt file in `prompts/`.

### Step 1: Detect and classify changes

Follow `prompts/01-detect-changes.md`. Produce a structured list of changed files
categorized by type (CLI, MCP, core, schema, config, build, test, etc.).

### Step 2: Route changes to affected docs

Follow `prompts/02-route-and-plan.md`. Map each classified change to the specific
documentation files that must be updated, using the change-to-doc routing table.
Produce an ordered update plan grouped by disjoint doc areas.

### Step 3: Apply documentation updates

Follow `prompts/03-apply-updates.md`. Make the edits, honoring the layering contract.
Parallelize across disjoint groups (see Sub-agent guidance below). Verify every
identifier, path, flag, and default against the real source before writing.

### Step 4: Verify

Follow `prompts/04-verify.md`. Run accuracy checks, link validation, duplication
detection, and `npm run validate`.

### Step 5: Report

Produce a report from `templates/update-report.md` summarizing what was updated, what
was verified, and any manual follow-ups needed.

## Sub-agent guidance

Parallelize Step 3 across DISJOINT doc directories to avoid conflicting edits to the
same file. The disjoint groupings are:

| Group | Files owned | Notes |
|-------|-------------|-------|
| A: Architecture + Concepts | `docs/architecture.md`, `docs/concepts/*.md` | High-level design and mental models |
| B: Reference | `docs/reference/*.md` | Precise lookup-oriented facts |
| C: Internals | `docs/internals/*.md` | Private implementation docs |
| D: Specs + Decisions | `docs/specs/*.md`, `docs/decisions/*.md` | Normative contracts and ADRs |
| E: Root-level + Testing | `README.md`, `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/README.md`, `docs/testing.md`, `docs/troubleshooting.md` | Top-level entry points and guides |
| F: Examples | `examples/**` | Runnable code samples |

Each sub-agent receives ONLY its group's files. A single sub-agent must never edit
files from two groups. If a change touches files in multiple groups, dispatch one
sub-agent per group.

## Definition of done

All of the following must be true before the skill reports success:

1. Every touched public surface (CLI command, MCP tool, library export, config option,
   error code) is documented in the correct `docs/reference/` file.
2. Layering is respected: each fact lives in exactly one place per the contract in
   `prompts/03-apply-updates.md`.
3. No duplication between `AGENTS.md`, `docs/`, and `README.md` -- cross-reference
   instead of copying.
4. All relative markdown links resolve (verified by `scripts/check-links.mjs`).
5. `docs/README.md` index matches the actual file tree (verified by
   `scripts/doc-inventory.mjs`).
6. `npm run validate` passes.
7. The `tests/autostart-removal.test.ts` guard test still passes (no reintroduction of
   removed-feature strings).
8. A report is written from `templates/update-report.md`.

## Key references

- Documentation layering contract: `prompts/03-apply-updates.md`
- Change-to-doc routing table: `prompts/02-route-and-plan.md`
- ADR template: `docs/decisions/0000-template.md` (source of truth)
- Spec template: `docs/specs/TEMPLATE.md` (source of truth)
- Architecture review skill: `.github/skills/review-crontick/SKILL.md`
