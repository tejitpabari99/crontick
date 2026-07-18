# Contributing

Thanks for helping improve crontick.

## DCO

All commits must include a `Signed-off-by` trailer. Use:

```sh
git commit -s
```

## Commit style

Prefer focused commits with imperative subjects, for example:

- `feat: add cron preview validation`
- `fix: redact github tokens in run logs`
- `docs: expand MCP setup guide`

Include a changeset for user-facing changes.

## Branch flow

1. Branch from `main`
2. Make the smallest coherent change set
3. Run `npm run typecheck && npm run lint && npm run build && npm test`
4. Open a PR against `main`

## Changesets

We use [Changesets](https://github.com/changesets/changesets).

- patch = bug fix
- minor = additive feature
- major = breaking change

Create one with `npx changeset` unless the PR is internal-only or explicitly excluded by maintainers.

## Release requirements

- CI green on supported OS/Node matrix
- lockfile verification passes
- tarball verification passes
- docs updated when behavior changes
