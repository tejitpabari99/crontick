@AGENTS.md

## Claude Code

- Read the relevant `specs/` file before editing any feature implementation.
- Use plan mode for changes that affect the public API or `SURFACE_CAPABILITIES`.
- Do not modify release workflows (`.github/workflows/release.yml`) unless explicitly requested.
- Prefer reading `docs/internals/` for module design over re-reading the full source tree.
- Run `npm run validate` as a single verification step rather than individual checks.
- When adding a capability, start from the `SURFACE_CAPABILITIES` entry and work outward to each shim.
