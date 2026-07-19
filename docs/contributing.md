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

### Registry-touching tests

A small number of Windows autostart tests write to `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` under a scratch value name to verify the real registration path end-to-end. These are gated behind `CI` and skipped on local machines by default, because the write pattern can trigger EDR alerts on corp-managed devices.

- CI runs them automatically (GitHub Actions sets `CI=true`).
- To run them locally, set `CRONTICK_RUN_REGISTRY_TESTS=1` before invoking `npm test`.

```powershell
$env:CRONTICK_RUN_REGISTRY_TESTS = '1'; npm test
```

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
