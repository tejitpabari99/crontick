# 0010: Use tsup as the build tool

- Status: Accepted
- Date: 2026-07-18

## Context

crontick is a TypeScript project that produces four entry points: a CLI binary, a daemon
binary, an MCP server binary, and a library entry. The build tool must:

1. Bundle each entry point into a single file (for fast startup and clean `bin` entries).
2. Emit ESM output with correct `#!/usr/bin/env node` shebangs.
3. Generate `.d.ts` declaration files for the library entry.
4. Support `define` for build-time constants (version injection).
5. Be fast enough for iterative development.

## Decision

Use `tsup` (v8.3) -- a zero-config TypeScript bundler built on esbuild:

```typescript
// tsup.config.ts
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
});
```

A post-build `onSuccess` hook copies static dashboard assets to `dist/dashboard`.
A separate `scripts/fix-node-sqlite.mjs` rewrites bare `"sqlite"` imports to
`"node:sqlite"` since esbuild does not recognize the `node:` protocol prefix for
built-in externalization.

## Alternatives considered

**`tsc` only (no bundler).** Emits one `.js` per `.ts` file. Pros: zero config. Cons:
no bundling (many small files in dist), no shebang injection, no `define`, slower cold
starts for CLI.

**`esbuild` directly.** tsup is a thin wrapper around esbuild; using esbuild directly
saves one dependency but loses the declarative config, automatic `.d.ts` generation
(which esbuild does not support natively), and the `onSuccess` hook.

**`rollup` + plugins.** More configurable but significantly more boilerplate for a
Node.js-targeted build. Plugin ecosystem is browser-oriented.

**`webpack`.** Heavy, slow, designed for browser bundles. Poor fit for Node.js CLI tools.

**`unbuild` (unjs).** Similar goals to tsup but less mature TypeScript declaration
support at the time of evaluation.

## Consequences

**Easier:**

- Single `tsup.config.ts` file defines the entire build.
- Sub-second incremental builds via esbuild.
- Shebang, sourcemaps, declarations, and version injection handled declaratively.
- `npm run build` is `tsup && node scripts/fix-node-sqlite.mjs` -- two steps, both fast.

**Harder:**

- The `fix-node-sqlite.mjs` post-build script is a workaround for esbuild not
  understanding `node:sqlite` externalization. If esbuild adds `node:` protocol support,
  this script can be removed.
- tsup's `.d.ts` generation uses a separate `tsc` pass under the hood, which can be
  slow on large codebases (acceptable here given ~30 source files).
- Debugging bundled output requires sourcemap support in the debugger.

**Impossible:**

- Tree-shaking unused exports from the library entry (esbuild does not tree-shake ESM
  entry points in library mode; consumers' bundlers handle this downstream).

## Revisit when

- esbuild or Node.js natively handle `node:sqlite` externalization, eliminating the
  post-build fixup.
- The project grows to need watch-mode bundling for development (tsup supports this but
  it is not currently configured).
- A compelling alternative emerges that handles declarations without a separate `tsc`
  pass.
