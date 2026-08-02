Follow the repository conventions and validation requirements in `AGENTS.md`.

Before proposing a change:

- Identify whether the public API (`src/index.ts` exports) is affected.
- If adding or modifying a capability, verify the surface parity rule: core client, CLI, MCP, and `SURFACE_CAPABILITIES` must all be updated together.
- Read the relevant `docs/specs/` file for normative requirements and `docs/decisions/` for prior rationale.
- Run `npm run validate` to confirm lint, typecheck, tests, and build all pass.
- If the change is user-visible, ensure documentation in `docs/reference/` is updated and a changeset is added.
