# Step 1: Detect and classify changes

## Objective

Determine the change set and produce a structured classification of what changed.

## Procedure

1. Resolve the diff source based on user input:
   ```powershell
   # Uncommitted work (default)
   git --no-pager diff HEAD --stat
   git --no-pager diff HEAD

   # If working tree is clean, fall back to last commit
   git --no-pager diff HEAD~1...HEAD --stat
   git --no-pager diff HEAD~1...HEAD

   # Explicit commit range
   git --no-pager diff <ref>...HEAD --stat
   git --no-pager diff <ref>...HEAD

   # PR
   gh pr diff <n> --repo tejitpabari99/crontick
   ```

2. From the stat output, classify each changed file into one or more categories:

| Category | File patterns |
|----------|--------------|
| CLI | `src/cli/**` |
| MCP | `src/mcp/**` |
| Core/Client | `src/client.ts`, `src/job-input.ts`, `src/surface.ts` |
| Schema | `src/schemas/**` |
| Daemon | `src/daemon/**` |
| Public exports | `src/index.ts` |
| Config/Env | Files touching env vars, config parsing, or `src/config*` |
| Build/CI | `package.json`, `tsconfig*`, `tsup.config*`, `.github/workflows/**`, `scripts/**` |
| Test | `tests/**` |
| Docs | `docs/**`, `specs/**`, `examples/**`, `README.md`, `AGENTS.md`, `CLAUDE.md` |
| Plugin/Skill | `plugin/**`, `src/skill/**`, `.github/skills/**` |
| Other | Anything not matching above |

3. For each non-Docs, non-Test category with changes, read the full diff to understand
   WHAT changed (new commands, removed flags, renamed methods, changed defaults, new
   errors, schema field additions/removals, etc.).

4. For each changed file in the Core/Client, CLI, MCP, and Schema categories, also check
   whether the change introduces or removes a capability listed in `src/surface.ts`.

## Output format

Produce a markdown table:

```markdown
## Change classification

| File | Category | Nature of change |
|------|----------|-----------------|
| src/cli/index.ts | CLI | Added `crontick stats` command with --json flag |
| src/client.ts | Core/Client | Added `statsSummary()` method |
| ... | ... | ... |

### Capability changes
- Added: <name> (if any)
- Removed: <name> (if any)
- Modified: <name> -- <what changed> (if any)
```

Pass this classification to Step 2.
