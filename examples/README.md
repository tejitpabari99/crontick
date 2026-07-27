# crontick examples

Self-contained, runnable examples that exercise the **public API** of the `crontick` package (`import { ... } from 'crontick'`) and its three bin commands (`crontick`, `crontick-daemon`, `crontick-mcp`).

All library examples import exclusively from the `"crontick"` package specifier -- never from internal `src/` or `dist/` paths.

## Prerequisites

- **Node.js >= 22.5** (see `engines` in package.json)
- Install crontick globally or link locally:
  ```sh
  npm install -g crontick
  # or, from the repo root:
  npm link
  ```
- To run `.ts` examples directly, install `tsx`:
  ```sh
  npm install -g tsx
  ```

## Library API examples

| File | What it demonstrates | How to run |
|------|---------------------|------------|
| `01-quick-start.ts` | Create client, add interval script job, list jobs, delete | `npx tsx examples/01-quick-start.ts` |
| `02-cron-schedule.ts` | Cron schedule with timezone, preview next runs, validate | `npx tsx examples/02-cron-schedule.ts` |
| `03-exec-job.ts` | Exec action (no shell) with command + args | `npx tsx examples/03-exec-job.ts` |
| `04-prompt-job.ts` | Prompt action with engine, list engines | `npx tsx examples/04-prompt-job.ts` |
| `05-one-shot.ts` | One-shot schedule (run-at a specific time) | `npx tsx examples/05-one-shot.ts` |
| `06-run-history.ts` | Trigger run, read run record and logs | `npx tsx examples/06-run-history.ts` |
| `07-lifecycle.ts` | Enable/disable/update/delete job; daemon start/status/stop | `npx tsx examples/07-lifecycle.ts` |

## CLI examples

See [`cli/README.md`](cli/README.md) for copy-pasteable command sequences.

## MCP examples

See [`mcp/README.md`](mcp/README.md) for MCP server registration and tool call examples.

## Type-checking

These examples are intended to be type-checked in CI. They require a tsconfig that includes `examples/**/*.ts` with appropriate module resolution. The root `tsconfig.json` currently includes only `src/` and `tests/`; a separate `examples/tsconfig.json` or an update to the root include array would be needed to cover these files.
