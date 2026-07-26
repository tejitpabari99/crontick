# Build and Package

Implements: `tsup.config.ts`, `package.json`, `scripts/fix-node-sqlite.mjs`

This document covers the build pipeline, output layout, npm package structure,
and the changesets release flow.

---

## tsup Configuration (`tsup.config.ts`)

```ts
export default defineConfig({
  entry: {
    'cli/index': 'src/cli/index.ts',
    'daemon/index': 'src/daemon/index.ts',
    'mcp/index': 'src/mcp/index.ts',
    index: 'src/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  platform: 'node',
  banner: { js: '#!/usr/bin/env node' },
  define: { __CRONTICK_VERSION__: JSON.stringify(version) },
  onSuccess() { cpSync('src/dashboard', 'dist/dashboard', { recursive: true }); },
});
```

Key points:
- **ESM only** -- no CJS output.
- **Node 22 target** -- modern syntax preserved.
- **Shebang banner** applied to all outputs (including `dist/index.js` which is
  a library; harmless but present).
- **`__CRONTICK_VERSION__`** injected at build time from `package.json`.
- **Dashboard assets** copied verbatim on success (static HTML/CSS/JS).

---

## Post-Build: `scripts/fix-node-sqlite.mjs`

esbuild (used by tsup) strips the `node:` prefix from built-in module imports.
Node.js requires `node:sqlite` specifically. This script walks `dist/` and
rewrites `from "sqlite"` / `import("sqlite")` back to `node:sqlite`.

Build command: `tsup && node scripts/fix-node-sqlite.mjs`.

---

## dist/ Layout

After `npm run build`:

```
dist/
  cli/
    index.js          # CLI entry (shebang)
    index.d.ts
    index.js.map
  daemon/
    index.js          # Daemon entry (shebang)
    index.d.ts
    index.js.map
  mcp/
    index.js          # MCP entry (shebang)
    index.d.ts
    index.js.map
  dashboard/
    index.html        # Static dashboard
    dashboard.css
    dashboard.js
  index.js            # Library entry
  index.d.ts          # Public types
  index.js.map
```

---

## exports Map (`package.json`)

```json
{
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js",
    "default": "./dist/index.js"
  },
  "./package.json": "./package.json"
}
```

Only the library surface (`dist/index.js`) is publicly importable. The CLI,
daemon, and MCP entries are accessed only via `bin` scripts.

---

## bin Shims

```json
{
  "crontick": "./dist/cli/index.js",
  "crontick-daemon": "./dist/daemon/index.js",
  "crontick-mcp": "./dist/mcp/index.js"
}
```

All three have the shebang `#!/usr/bin/env node` from the tsup banner. On
install, npm creates platform-appropriate shims (`.cmd` on Windows).

---

## files Allowlist

```json
["dist", "plugin/**", "src/skill/SKILL.md", "README.md", "LICENSE"]
```

Only these paths are included in the published tarball. Source code under `src/`
is excluded (except the skill markdown). Tests, scripts, and config files are
not shipped.

---

## Changesets Release Flow

Dependency: `@changesets/cli` (dev).

### Creating a changeset

```sh
npx changeset
# Follow prompts: select packages, bump type, description.
# Creates .changeset/<slug>.md
```

### Release process

1. **CI** (`workflows/release.yml`): on push to `main`, the
   `changesets/action` GitHub Action opens a "Version Packages" PR that bumps
   `package.json` and updates `CHANGELOG.md`.
2. Merge the version PR.
3. The release workflow runs `changeset publish` with npm provenance.

npm script: `"release": "changeset publish"`.

Prepublish gate: `"prepublishOnly": "npm run validate"` (lint, typecheck, source
and dist example type-checking, full test suite, and a full build — see the
`validate` script in `package.json`; `verify-package-install` is not part of
`validate` and only runs in CI, see Packaging Pitfalls #6 below).

---

## Packaging Pitfalls

1. **node:sqlite rewrite**: must run `fix-node-sqlite.mjs` after every build.
   Already chained in `"build"` script. If skipped, daemon crashes at runtime on
   Node < 24 with `Cannot find module 'sqlite'`.
2. **Dashboard copy**: `onSuccess` in tsup copies static assets. If tsup is run
   with `--no-clean` and dashboard source changed, stale assets may persist.
3. **Shebang on library**: `dist/index.js` has a shebang line. Harmless for
   `import` consumers but visible if the file is inspected.
4. **Provenance**: `publishConfig.provenance: true` requires the release to run
   in GitHub Actions with `id-token: write` permission.
5. **Tarball verification**: `scripts/verify-tarball.mjs` checks the output of
   `npm pack --dry-run` against expectations. Run in CI to catch accidental
   inclusion of dev files.
6. **Example type-checking against source vs. against published types**:
   `examples/tsconfig.json` maps the `crontick` import specifier to
   `../src/index.ts`, so `npm run typecheck:examples` (part of `validate`)
   validates examples against the *source* type surface rather than the
   published declaration output (`dist/index.d.ts`). If the declaration
   rollup ever diverged from source, an example could type-check locally
   while being broken for real consumers. This gap is closed by two
   additional, separate checks rather than by the `verify-package` CI job
   alone:
   - **`npm run typecheck:examples:dist`** (also part of `validate`, and run
     again standalone in the `verify-package` CI job after a fresh build):
     `scripts/check-dist-built.mjs` first asserts `dist/index.d.ts` exists
     (giving an actionable "run `npm run build` first" error instead of a
     confusing TypeScript "project root is ambiguous" failure), then
     `tsc --project examples/tsconfig.dist.json` type-checks every example
     against the *built* declaration file via a separate tsconfig that remaps
     the `crontick` specifier to `../dist/index.d.ts`.
   - **`npm run verify-package-install`** (`scripts/verify-package-install.mjs`,
     CI-only, not part of `validate`): packs a real tarball with `npm pack`
     (not `--dry-run`), installs it into a scratch directory, imports the
     installed package and checks for the presence of every required public
     export, runs `crontick --version` and asserts a clean exit, and starts
     `crontick-daemon` and `crontick-mcp` each under a timeout to confirm the
     bin actually launches (see [cli.md](../reference/cli.md) — neither of
     those two bins parses `--help`/argv at all, so "launches and stays up
     until killed" is the only exercisable success signal for them).
   Both checks now also run in the `verify-package` CI job (`.github/workflows/ci.yml`),
   alongside the pre-existing `scripts/verify-tarball.mjs` tarball-contents check.
