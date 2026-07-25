# 0007: Use zod for schema validation at every surface boundary

- Status: Accepted
- Date: 2026-07-18

## Context

crontick accepts structured input from three surfaces (CLI flags, MCP JSON-RPC params,
programmatic TypeScript calls) and from persisted files (job JSON, config JSON). Invalid
input must be caught early with actionable error messages rather than failing deep in
business logic with cryptic stack traces.

## Decision

Use `zod` (v4) as the single validation and schema definition library:

- All domain schemas (`JobSchema`, `ScheduleSchema`, `ActionSchema`, `ConfigSchema`) are
  defined as zod schemas in `src/schemas/`.
- Every surface boundary calls `.parse()` or `.safeParse()` before passing data to the
  core -- the daemon API validates with `JobSchema`, the client validates config, etc.
- Type inference (`z.infer<typeof Schema>`) generates TypeScript types, ensuring runtime
  validation and compile-time types are always in sync.
- `zod-to-json-schema` generates the JSON Schema sidecar files and the MCP resource
  (`crontick://schemas/job`), so there is a single source of truth.
- Discriminated unions (`z.discriminatedUnion('kind', [...])`) model the schedule and
  action variants, giving precise error messages on kind mismatch.

## Alternatives considered

**`ajv` + JSON Schema first.** Write JSON Schema by hand, generate types with
`json-schema-to-typescript`. Viable but:

- JSON Schema is verbose and harder to compose programmatically.
- Two artifacts to keep in sync (schema + types) instead of one (zod schema -> both).
- No discriminated-union ergonomics without custom keywords.

**`io-ts` / `effect/Schema`.** Functional-style decoders. Steeper learning curve, less
ecosystem adoption, heavier dependency weight.

**Manual validation.** Handwritten `if/throw` chains. Error-prone, no schema
introspection, no automatic JSON Schema generation for tooling consumers.

**`joi` / `yup`.** Mature but designed for form validation, not TypeScript-first schema
definition. Weaker type inference, larger bundle.

**TypeScript types only (no runtime validation).** Sufficient for library callers but
provides zero safety for CLI flags, MCP params, or persisted JSON where types are erased.

## Consequences

**Easier:**

- Adding a new field or variant is one zod line; types, validation, and JSON Schema
  update automatically.
- Error messages from `.parse()` are structured and human-readable -- surfaced directly
  in CLI/MCP error responses.
- The `crontick://schemas/job` MCP resource is always consistent with actual validation
  because both derive from the same zod source.

**Harder:**

- zod is a runtime dependency shipped in the production bundle (though small at ~15 KB
  minified).
- Complex schemas (superRefine, transform) can be harder to read than equivalent JSON
  Schema.
- Upgrading zod major versions may require schema syntax changes across the codebase.

**Impossible:**

- Accepting input that does not conform to the declared schema (by design -- fail-fast
  at the boundary).

## Revisit when

- zod's maintenance stalls or a critical vulnerability is discovered without upstream
  patching.
- A standard emerges that unifies runtime validation and TypeScript types at the
  language level (e.g., a future TC39 proposal for type annotations at runtime).
- The production bundle size becomes a concern and a lighter alternative covers all
  current usage patterns.
