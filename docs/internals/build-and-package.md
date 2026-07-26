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

Prepublish gate: `"prepublishOnly": "npm run build && npm test"`.

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
6. **Example type-checking against source**: `examples/tsconfig.json` maps the
   `crontick` import specifier to `../src/index.ts`, so `npm run typecheck:examples`
   validates examples against the source type surface rather than the published
   declaration output (`dist/index.d.ts`). If the declaration rollup ever diverges
   from source, an example could type-check locally while being broken for real
   consumers. This risk is mitigated by the `verify-package` CI job (which installs
   the packed tarball and imports it) and the manual pre-release checklist in
   `docs/testing.md` that covers importing from the tarball.
