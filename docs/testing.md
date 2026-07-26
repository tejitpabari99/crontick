# Testing

## Test layers

| Layer | Files | Guarantees |
|-------|-------|------------|
| Unit | `store.test.ts`, `scheduler.test.ts`, `runner.test.ts`, `config.test.ts`, `logging.test.ts`, `redact.test.ts`, `job-input.test.ts` | Core modules work in isolation with injectable deps |
| Integration | `api.test.ts`, `cli.test.ts`, `mcp.test.ts`, `client.test.ts`, `integration.*.test.ts` | Real daemon processes, real HTTP, real MCP stdio |
| Surface parity | `surface-drift.test.ts` | CLI, MCP, and library expose every `SURFACE_CAPABILITIES` entry |
| Fuzz / Property | `fuzz.*.test.ts`, `property.*.test.ts` | Schema validation never panics; scheduler invariants hold for arbitrary inputs |
| Packaging | `smoke.test.ts`, `build-sqlite.test.ts`, `rebrand.test.ts` | Package exports resolve; dist builds are valid |

## Running tests locally

```powershell
# Full suite (requires a prior build)
npm run build
npm test
```

```powershell
# Single file
npx vitest run tests/cli.test.ts
```

```powershell
# Single test by name pattern
npx vitest run -t "creates a job"
```

```powershell
# Watch mode (re-runs on file change)
npm run test:watch
```

```powershell
# With coverage (vitest built-in)
npx vitest run --coverage
```

All test commands are cross-platform (Windows and Linux/macOS).

## Test layout

```
tests/
  api.test.ts              Integration: daemon HTTP API
  cli.test.ts              Integration: CLI spawns, exit codes, output
  mcp.test.ts              Integration: MCP server via SDK client
  client.test.ts           CrontickClient against fake/real daemons
  surface-drift.test.ts    Parity: all surfaces expose every capability
  store.test.ts            Unit: SQLite store CRUD, migrations
  scheduler.test.ts        Unit: cron/interval/one-shot scheduling
  runner.test.ts           Unit: process spawning, overlap, timeout
  config.test.ts           Unit: config load/write/engines
  integration.*.test.ts    Integration scenarios (persistence, retry, overlap, timeout)
  fuzz.*.test.ts           Property-based fuzz (fast-check) for API, MCP, env-file, paths
  property.*.test.ts       Property-based: cron preview, scheduler invariants, schema
  security.test.ts         API auth/binding/traversal hardening
  perf.test.ts             Advisory perf baselines (not gated)
  smoke.test.ts            Package export sanity
  ...
```

Naming convention: `<module-or-layer>.<optional-qualifier>.test.ts`. Place new tests in `tests/` at the root level. Name regression tests after the bug: `tests/<area>.<ticket-or-slug>.test.ts`.

## Writing tests

- Use `vitest` (`describe`/`it`/`expect`). No globals beyond vitest.
- Use `vi.useFakeTimers()` for scheduler tests; call `vi.useRealTimers()` in `afterEach`.
- Create a scratch state directory per test (helper pattern: `makeTmpDir()` under `os.tmpdir()`). Set `CRONTICK_HOME` to it. Clean up in `afterEach`/`finally`.
- Tests must not depend on execution order.
- Every bug fix must have a regression test that fails without the fix.
- Use `fast-check` for property/fuzz tests (dev dependency).
- Inject `spawn` into `Runner` for unit-level tests; use real processes for integration.
- Never assert on wall-clock time. Use fake timers or generous timeouts.

## Testing the three surfaces

### Library API

**Automated coverage:** `tests/smoke.test.ts` (export sanity), `tests/client.test.ts` (full CrontickClient against fake and real daemons).

**Manual end-to-end:**

```javascript
// save as verify-lib.mjs and run: node verify-lib.mjs
import { createClient } from './dist/index.js';

const client = createClient({ verbose: true });
const health = await client.health();
console.log('health:', health);

await client.createJob({
  id: 'lib-test',
  schedule: { kind: 'interval', everySec: 5 },
  action: { kind: 'exec', command: 'echo', args: ['hello from lib'] },
});
const jobs = await client.listJobs();
console.log('jobs:', jobs);

await client.deleteJob('lib-test');
```

Expected: `health` shows `{ status: 'ok', ... }`, job appears in list, then disappears after delete.

### CLI

**Automated coverage:** `tests/cli.test.ts` (spawns `dist/cli/index.js` with temp home, covers CRUD, daemon lifecycle, schedule commands, error paths).

**Manual end-to-end:**

```powershell
# Start daemon
crontick daemon start

# Create an exec job on a 5-second interval
crontick new my-test --every 5 --exec echo -- "hello"

# Verify it appears
crontick list
crontick get my-test

# Wait >5s, check runs
crontick runs list --job my-test

# View logs for a run
crontick logs <run-id>

# Clean up
crontick delete my-test
crontick daemon stop
```

Expected: `list` shows the job enabled, `runs list` shows at least one `success` run after the interval fires, `logs` prints `hello`.

### MCP server

**Automated coverage:** `tests/mcp.test.ts` (starts real daemon + MCP server, drives all 36 tools via `@modelcontextprotocol/sdk` client over stdio). `tests/surface-drift.test.ts` verifies every tool is registered.

**Launch command:**

```powershell
node dist/mcp/index.js
```

Or via the CLI:

```powershell
crontick mcp
```

The server speaks JSON-RPC 2.0 over stdio. To drive it interactively, use the MCP Inspector:

```powershell
npx @modelcontextprotocol/inspector node dist/mcp/index.js
```

**Raw stdio smoke test (paste into stdin):**

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual","version":"0.0.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"crontick_daemon_status","arguments":{}}}
```

Expected: `tools/list` returns all 36 `crontick_*` tools; `crontick_daemon_status` returns a JSON text content block.

**Key tools to smoke-test:** `crontick_job_create`, `crontick_job_list`, `crontick_daemon_status`, `crontick_schedule_preview`, `crontick_doctor`.

## Surface parity checks

The `SURFACE_CAPABILITIES` constant in `src/surface.ts` is the single source of truth mapping each capability to its `clientMethod`, `cliCommand`, and `mcpTool`.

`tests/surface-drift.test.ts` enforces:

1. Every capability has a matching method on `CrontickClient.prototype`.
2. Every `CrontickClient` public method is accounted for (in the table or in `NON_PARITY_CLIENT_METHODS`).
3. Every CLI command responds to `--help` without error.
4. Every MCP tool is registered and has a `verbose` input property.

**When adding a new operation:** add it to `SURFACE_CAPABILITIES`, implement it in `CrontickClient`, expose via CLI and MCP, then run the drift test. It will fail if any surface is missing the new entry.

## Continuous integration

Workflow file: `.github/workflows/ci.yml`

| OS | Node | Steps |
|----|------|-------|
| `windows-latest` | 22 | install, lockfile verify, typecheck, lint, build, test, audit signatures |
| `windows-latest` | 24 | same |
| `ubuntu-latest` | 22 | same |
| `ubuntu-latest` | 24 | same |

A second job `verify-package` (ubuntu-latest, Node 22) runs after the matrix: `npm pack --dry-run` + `scripts/verify-tarball.mjs`.

Additional workflows:

- `.github/workflows/release.yml` -- changesets publish on main push (after build + test + tarball verify).
- `.github/workflows/audit.yml` -- weekly `npm audit --production` + signature check.

## Manual pre-release verification

### Fresh install

- [ ] `npm run build` succeeds without warnings
- [ ] `npm pack` produces a tarball
- [ ] In a new empty directory, `npm install <path-to-tarball>` succeeds
- [ ] `npx crontick --version` prints the expected version
- [ ] `npx crontick-mcp` starts without crash (Ctrl+C to exit)

### Job kinds

- [ ] Create a `script` job: `crontick new s1 --every 10 --script "echo script-ok"`
- [ ] Create an `exec` job: `crontick new e1 --every 10 --exec echo -- "exec-ok"`
- [ ] Create a `prompt` job: `crontick new p1 --every 60 --prompt "say hello"` (requires a configured engine)
- [ ] Each fires at least once and `crontick runs list` shows `success`

### Schedule kinds

- [ ] `cron`: `crontick new c1 --cron "* * * * *" --exec echo -- "tick"`
- [ ] `interval`: verified above
- [ ] `one-shot`: `crontick new o1 --at "<30-seconds-from-now-ISO>" --exec echo -- "once"` fires exactly once

### Daemon lifecycle

- [ ] `crontick daemon start` / `crontick daemon status` shows running
- [ ] `crontick daemon stop` stops it; status confirms
- [ ] `crontick daemon restart` returns to running
- [ ] Kill daemon process externally, then run any command: daemon demand-starts
- [ ] Create a job while daemon is down; start daemon; job fires at next scheduled time

### State directory

- [ ] Delete `CRONTICK_HOME` entirely; `crontick daemon start` recreates it
- [ ] With an existing populated state directory, upgrade (reinstall new version); jobs and runs survive

### Three surfaces

- [ ] CLI: run through the manual CLI steps above
- [ ] Library: run `verify-lib.mjs` snippet above
- [ ] MCP: launch `crontick mcp`, send `initialize` + `tools/list` via inspector or raw JSON

### Cross-platform (Windows-specific)

- [ ] On Windows, `script` jobs with `shell: "auto"` use PowerShell (check run output)
- [ ] Path separators in `CRONTICK_HOME` work with backslashes
- [ ] Long command lines for prompt jobs do not exceed 8191-char Windows limit (validated by `prompt-runtime.ts`)

### Error paths

- [ ] Invalid cron expression: `crontick schedule validate '{"kind":"cron","cron":"bad"}'` returns error
- [ ] Failing command: job with `exit 1` shows `failed` status in runs
- [ ] Missing binary: `crontick new bad --every 5 --exec nonexistent-binary-xyz` run fails with actionable error

### Docs / examples

- [ ] README quick-start commands still work
- [ ] `docs/reference/cli.md` matches `crontick --help` output

## Release checklist

1. Create a changeset: `npx changeset` (follow prompts for semver bump and summary).
2. Run validation:
   ```powershell
   npm run typecheck
   npm run lint
   npm run build
   npm test
   ```
3. Review tarball contents: `npm pack --dry-run` (expect `dist/`, `plugin/`, `src/skill/SKILL.md`, `README.md`, `LICENSE`).
4. Smoke-test the tarball:
   ```powershell
   npm pack
   mkdir scratch && cd scratch
   npm init -y && npm install ../crontick-<version>.tgz
   npx crontick --version
   ```
5. Commit the changeset file and push to `main`.
6. The `release.yml` workflow creates a version PR via `changesets/action`; merge it.
7. On merge, `changesets/action` publishes to npm with provenance.

See [../RELEASING.md](../RELEASING.md) and [../CONTRIBUTING.md](../CONTRIBUTING.md) for full details.

## Troubleshooting tests

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Cannot find module 'node:sqlite'` | Vite strips `node:` prefix | Handled by `nodeSqlitePlugin` in `vitest.config.ts`; ensure Node >= 22.5 |
| Tests hang or timeout | Daemon process leaked from prior run | Kill orphan `crontick-daemon` processes; delete `daemon.pid` in temp dirs |
| `EADDRINUSE` in parallel runs | Port conflict between test daemon instances | Each test uses its own temp `CRONTICK_HOME`; ensure cleanup in `afterEach` |
| Surface-drift test fails | New capability added without updating all three surfaces | Add entry to `SURFACE_CAPABILITIES`, implement in client, CLI, and MCP |
| `npm test` fails on Windows but not Linux | Path separator or shell differences | Check `shell: "auto"` resolves to `pwsh`; use `path.join()` not string concat |
| Flaky fuzz tests | `fast-check` seed-dependent | Re-run with `--reporter=verbose`; set `seed` in property config to reproduce |
