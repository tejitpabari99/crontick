# Contributing to crontick

Thank you for your interest in contributing!

## DCO sign-off

All commits must include a `Signed-off-by` trailer (Developer Certificate of Origin):

```
Signed-off-by: Your Name <you@example.com>
```

Add it automatically with `git commit -s`. By signing off you certify that you have the right to
submit the contribution under the MIT license. See <https://developercertificate.org/>.

## Development setup

```sh
node --version   # must be >= 22.5
npm install
npm run build
npm test
```

## PR process

1. Fork the repo and create a branch: `git checkout -b feat/my-feature`.
2. Make your changes. Write or update tests.
3. Run `npm run typecheck && npm run lint && npm run build && npm test` — all must pass.
4. Open a pull request against `main`. Fill in the PR template.
5. A maintainer will review within a few days.

## Changesets

We use [Changesets](https://github.com/changesets/changesets) for versioning.

- If your PR changes user-facing behaviour, run `npx changeset` and commit the generated file.
- Patch: bug fixes. Minor: new features. Major: breaking changes.

## Code style

- TypeScript strict mode. No `any` casts without a comment explaining why.
- Prettier + ESLint enforced in CI. Run `npm run format` before committing.
