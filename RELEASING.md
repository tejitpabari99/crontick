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

## Release flow

1. Merge changes to `main`
2. GitHub Actions `release.yml` runs package verification
3. `changesets/action` either opens/updates a release PR or publishes to npm
4. Publish uses npm provenance (`--provenance`)

## Release PR contents

The release PR updates package versions, changelog content, and consumes pending changesets.

## Tarball verification

`node scripts/verify-tarball.mjs` checks that the packed artifact includes:

- built CLI, daemon, and MCP outputs
- `plugin/install.mjs`
- `src/skill/SKILL.md`
- `README.md` and `LICENSE`

It also ensures test files are not shipped.
