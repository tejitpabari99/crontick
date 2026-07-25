# 0011: Use changesets for versioning and releases

- Status: Accepted
- Date: 2026-07-18

## Context

crontick is published to npm as a public package with provenance. It needs a versioning
strategy that:

1. Tracks which changes are breaking, minor, or patch.
2. Generates changelogs automatically.
3. Integrates with GitHub Actions for automated publishing.
4. Allows multiple PRs to accumulate changes before a release.

## Decision

Use `@changesets/cli` (v2.27) for version management:

- `.changeset/config.json` configures `"access": "public"` and `"baseBranch": "main"`.
- Contributors add a changeset file (markdown in `.changeset/`) describing their change
  and its semver impact (patch/minor/major).
- The `release.yml` GitHub Actions workflow uses `changesets/action` to:
  1. Detect pending changesets.
  2. Open a "Version Packages" PR that bumps `package.json` and updates `CHANGELOG.md`.
  3. On merge of that PR, run `npm publish` with provenance.
- The `npm run release` script maps to `changeset publish` for manual use.

## Alternatives considered

**`standard-version` / `release-please`.** Derive version bumps from conventional
commit messages. Pros: no manual changeset step. Cons: requires strict commit message
discipline across all contributors; harder to accumulate intentional breaking changes
across multiple PRs before cutting a release.

**Manual version bumps.** Edit `package.json` by hand, write changelog manually.
Error-prone, no automation, easy to forget.

**`semantic-release`.** Fully automated from commit messages; publishes on every merge
to main. Too aggressive for a pre-1.0 project where the maintainer wants to batch
changes and review the changelog before publishing.

**`lerna` / `nx release`.** Designed for monorepos with multiple packages. Overkill for
a single-package repository.

## Consequences

**Easier:**

- Each PR explicitly declares its semver impact -- reviewers see the changeset file in
  the diff.
- CHANGELOG.md is generated consistently and linked to the version bump commit.
- Multiple breaking changes can accumulate in `.changeset/` and ship as one major bump.
- CI-driven publishing with npm provenance provides supply-chain transparency.

**Harder:**

- Contributors must remember to add a changeset file; PRs without one need reviewer
  follow-up.
- The "Version Packages" PR is an extra merge step in the release cadence.
- Changeset files can conflict if multiple PRs touch the same unreleased version.

**Impossible:**

- Publishing without a deliberate changeset (by design -- prevents accidental releases).

## Revisit when

- The project moves to a monorepo with multiple published packages (at which point
  changesets still works, but workspace configuration is needed).
- A requirement emerges for continuous deployment on every merge (would need
  `semantic-release` or similar).
- The single maintainer workflow makes the extra changeset step feel burdensome.
