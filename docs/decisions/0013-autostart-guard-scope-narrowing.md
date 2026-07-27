# 0013: Narrow the autostart-removal guard test to shipped product surfaces only

- Status: Accepted
- Date: 2026-07-26

## Context

`tests/autostart-removal.test.ts` is a regression guard from ADR-0003: it fails CI if the
removed OS login-item/registry-based daemon autostart feature (or its associated flags,
dependencies, and MCP tool) reappears anywhere in the tree.

Its file scope originally included `docs/` and `CHANGELOG.md` alongside `src/`, `plugin/`,
`scripts/`, `README.md`, `package.json`/`package-lock.json`, and `tsup.config.ts`. In practice
this over-broad scope caught legitimate prose *about* the removal, not the removed feature
itself: writing ADR-0003 (which necessarily discusses the removed feature by name to explain
why it was removed, commit `9adbd63`) tripped the guard and forced deletions/rewording of
legitimate historical documentation to pass CI. The same failure mode was about to recur for a
pending changeset (`.changeset/purple-crabs-prompt.md`) once it is consumed into
`CHANGELOG.md` on release -- changelog entries describing a past removal necessarily name the
removed feature too.

## Decision

Narrow the scanned-file regex to product and packaged-surface paths only: `src/`, `plugin/`,
`scripts/`, `README.md`, `package.json`, `package-lock.json`, `tsup.config.ts`. Remove `docs/`
and `CHANGELOG.md` from the scan. Every actual reappearance vector for the removed feature
(startup-registration code, a CLI flag, an MCP tool, a runtime dependency) still lives in one
of the remaining scanned paths, so removing prose-only locations from the scope does not weaken
the guard against the feature actually coming back -- it only stops the guard from firing on
documentation and changelog entries that correctly describe a past, intentional removal.

The test's inline comment records this rationale (citing ADR-0003 and the specific commit and
pending changeset) so a future reader does not re-widen the scope without understanding why it
was narrowed.

## Alternatives considered

**Keep scanning `docs/` and `CHANGELOG.md`, add per-file exceptions instead.** Rejected: this
degrades over time into an ever-growing allowlist of exempted files (every ADR mentioning the
removal, every changelog entry, every future doc that has to reference the history), each of
which needs a human to notice the guard fired, confirm it is a false positive, and add an
exception. The allowlist would eventually approximate "everything under docs/", making the
inclusion of `docs/` in the scan pointless.

**Keep the original scope; delete or reword the offending ADR/changelog content instead.** This
is what was actually done before this decision and is the problem being fixed: it produces
worse documentation (a design record that cannot honestly name the thing it explains) purely to
satisfy an over-broad test, which inverts the priority between code correctness and
documentation quality.

**Drop the guard test entirely.** Rejected: the test still provides real value against the one
thing it is designed to catch -- silent reintroduction of the feature in shipped code -- which
is the actual risk ADR-0003 was written to close off.

## Consequences

**Easier:**

- ADRs, specs, changelogs, and other docs can discuss the removed feature by name (as history
  requires) without tripping CI.
- The pending changeset can be consumed into `CHANGELOG.md` on the next release without forcing
  a rewording of its own description.

**Harder:**

- None identified: the scanned paths still cover every path through which the feature could
  practically reappear in the shipped package.

**Impossible:**

- The guard no longer catches a reintroduction of the removed feature if it is mentioned only
  in `docs/` or `CHANGELOG.md` prose without ever touching `src/`, `plugin/`, `scripts/`,
  `README.md`, `package.json`, or `tsup.config.ts` -- but such a mention would not constitute
  the feature actually being reintroduced, since none of the runtime paths would exist.

## Revisit when

- A future removed feature needs the same guard pattern and the same docs/changelog
  false-positive problem recurs -- confirm the same scoping rationale still applies before
  copying it.
- The scanned needle list grows to include terms plausible in ordinary documentation prose
  unrelated to the removed feature, which would argue for scoping needles instead of (or in
  addition to) scoping paths.
