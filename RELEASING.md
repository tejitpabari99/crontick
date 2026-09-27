# Releasing crontick

## Preflight

```sh
npm install
npm run typecheck
npm run build
npm test
node scripts/verify-no-lockfile-tampering.mjs
node scripts/verify-tarball.mjs
```

`prepublishOnly` also rebuilds and reruns tests during publish.

## Create a changeset

For user-facing changes:

```sh
npx changeset
```

Commit the generated markdown file under `.changeset/`.

## Release flow (manual only)

Nothing publishes automatically on merge to `main` -- releases are always triggered by hand:

1. **Actions -> Release -> Run workflow**, choose a `mode`:
   - **`version`** -- runs `changeset version` and opens/updates the "Version Packages" PR
     against `main` (bumps package versions, writes changelog entries, consumes pending
     changesets). Does not publish anything.
   - **`publish`** -- publishes the version already committed on `main` to npm (with
     provenance) and pushes the release git tag. Run this *after* merging the Version
     Packages PR from step above.
2. Both modes run behind a `verify-package` job (build, tests, tarball checks, packaged
   install/exercise) -- the `release` job only starts if that passes.

## Bump levels and the major-bump guard

- The bump for each package is whatever its changeset file(s) declare (`patch`, `minor`,
  or `major`) -- see [Create a changeset](#create-a-changeset). Multiple changesets are
  combined; the highest declared bump wins.
- Before versioning or publishing, the workflow runs
  `node scripts/check-changeset-bumps.mjs` (`npm run check:changesets`), which **fails the
  run if any pending changeset declares a `major` bump**. This also runs as a CI step on
  every PR, so a stray major changeset is caught at review time.
- **crontick is currently on a 0.x version** -- a `major` changeset would jump straight to
  `1.0.0`, which is almost never intended by accident. That's why it's blocked by default.
- To intentionally release a major/breaking change, tick the `allow_major` input when
  running the workflow (passed through as `ALLOW_MAJOR=true`), or run the script locally
  with the same env var to confirm first: `ALLOW_MAJOR=true npm run check:changesets`.
- The script also accepts `MAX_BUMP=patch|minor|major` for a stricter ceiling than the
  default (e.g. `MAX_BUMP=patch` blocks `minor` changesets too); an explicit `MAX_BUMP`
  takes precedence over `ALLOW_MAJOR`.

## Full manual control over the version

If you need an exact version rather than whatever the changesets compute:

- Edit the bump in a changeset's frontmatter before running the `version` mode (e.g. change
  `major` to `minor` in the `.changeset/*.md` file), or
- Run `npx changeset version` locally, then hand-edit `package.json`'s `version` (and
  `CHANGELOG.md` if desired) before committing/pushing the result, or use `npm version
  <exact-version> --no-git-tag-version` for a precise number, or
- For a pre-release channel (alpha/beta/rc), use changesets' pre-release mode:
  `npx changeset pre enter <tag>` before adding changesets, and `npx changeset pre exit`
  to leave it. Versions and publishes behave normally once out of pre mode.

## Release PR contents

The release PR updates package versions, changelog content, and consumes pending changesets.

## Tarball verification

`node scripts/verify-tarball.mjs` checks that the packed artifact includes:

- built CLI, daemon, and MCP outputs
- `plugin/install.mjs`
- `src/skill/SKILL.md`
- `README.md` and `LICENSE`

It also ensures test files are not shipped.
