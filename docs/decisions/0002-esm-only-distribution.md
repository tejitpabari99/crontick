# 0002: Publish as ESM-only package

- Status: Accepted
- Date: 2026-07-25

## Context

Node.js has supported ES modules natively since v12 (unflagged in v14+). crontick
targets Node >= 22.5 and uses top-level `await`, native `node:sqlite`, and other
ESM-first APIs. The initial 0.1.0 release included both ESM and CJS outputs via tsup,
but no downstream consumer reported needing CJS, and dual-format publishing introduces
edge cases around module state and conditional exports.

## Decision

Ship ESM only:

- `package.json` declares `"type": "module"`.
- `tsup.config.ts` specifies `format: ['esm']` -- no `cjs` entry.
- The `exports` map exposes only `"import"` and `"default"` (both point to the ESM
  bundle); no `"require"` condition exists.
- `tsconfig.json` uses `module: "NodeNext"` / `moduleResolution: "NodeNext"`.

The explicit cut was made in commit `36b0dd6` ("build!: publish ESM-only package") and
is tracked in the pending MAJOR changeset.

## Alternatives considered

**Dual ESM + CJS build.** tsup supports this with `format: ['esm', 'cjs']`. Rejected
because:

- crontick depends on ESM-only packages (`env-paths` v3, `croner` v9).
- Dual builds double the dist size and introduce potential dual-package hazard (shared
  mutable state loaded once per format).
- The minimum Node version (22.5) has full ESM support including `import.meta.resolve`.

**CJS-only.** Backward-compatible with older tooling, but precludes top-level `await`,
`import.meta`, and modern `node:*` protocol imports used throughout the codebase.

**Bundled IIFE/UMD.** Irrelevant for a Node.js CLI/daemon tool with no browser target.

## Consequences

**Easier:**

- One output format simplifies the build, reduces dist size, and eliminates conditional
  export resolution bugs.
- Authors can use top-level `await` and `import.meta` freely.
- Downstream library consumers get tree-shakeable imports.

**Harder:**

- Consumers using CommonJS-only toolchains (`require()`) cannot import crontick directly;
  they must use dynamic `import()` or upgrade their module system.
- Some older test tooling or bundlers that default to CJS resolution may need
  configuration changes.

**Impossible:**

- `require('crontick')` without an async wrapper.

## Revisit when

- A significant downstream consumer demonstrates a hard CJS requirement AND is willing
  to contribute a dual-build CI validation.
- The Node.js ecosystem shifts direction on module formats (unlikely given current
  trajectory).
