# Integration Harness

This directory contains a data-driven, on-demand E2E test harness for crontick. It is **entirely separate** from the vitest unit suite (`npm test`) — the harness does a real `npm pack` + install + daemon spawn, then drives crontick across CLI, API, and MCP surfaces. It is never run as part of `npm run validate` or the default CI job.

> **Name clarification:** Some files under `tests/unit/` are historically named `integration.*.test.ts`. Those are vitest in-process tests, not this harness. The word "integration" here refers to this on-demand harness only.

---

## Quick start

```sh
# Run the smoke tier (6 tests, <45s, no mock-engine setup required)
npm run e2e:smoke

# Run Tier 1 (all ~47 tests)
npm run e2e

# Run only one test by id
node tests/integration/run-harness.mjs --id CT-DAEMON-001

# List all tests in the smoke tier without executing them
node tests/integration/run-harness.mjs --tier smoke --list

# Dry-run Tier 1 (show what would run, then exit 0)
node tests/integration/run-harness.mjs --tier tier1 --dry-run
```

`npm run e2e` and `npm run e2e:smoke` are just aliases for `node tests/integration/run-harness.mjs` with appropriate flags.

---

## How it differs from the vitest unit suite

| | Vitest unit suite (`npm test`) | Integration harness (`npm run e2e`) |
|---|---|---|
| Entry point | `vitest run` | `node tests/integration/run-harness.mjs` |
| Runs in-process | ✓ | ✗ — spawns child processes |
| Real daemon | ✗ | ✓ — starts and stops a real daemon |
| Installs the package | ✗ | ✓ — `npm pack` + `npm install` into `.e2e-scratch/` |
| Part of `npm run validate` | ✓ | ✗ |
| Part of default CI | ✓ | ✗ (separate `e2e.yml`, manual/nightly) |
| Test definitions | TypeScript/vitest | JSON (`tests.json`) |

---

## CLI arguments

### Implemented now

| Argument | Description |
|---|---|
| `--start N` | Run tests with `seq >= N` |
| `--end M` | Run tests with `seq <= M`; combine with `--start` for a range |
| `--id CT-X-NNN` | Run exactly one test by id (overrides range/tier filters) |
| `--tier smoke\|tier1\|tier2\|tier3` | Run tests at this tier and all lower tiers (smoke ⊂ tier1 ⊂ tier2 ⊂ tier3) |
| `--area <area>` | Filter by area (e.g. `install`, `daemon`, `script`, `exec`, `prompt`, `parity`, …) |
| `--surface cli\|api\|mcp` | Filter to tests whose `surface` array includes the given value |
| `--list` | Print test IDs, titles, tiers, and platform-skip status; exit 0 without running |
| `--dry-run` | Print what would run (including platform-skipped tests); exit 0 without running |
| `--keep-home` | Skip teardown of per-test `CRONTICK_HOME` dirs (useful for debugging) |
| `--fail-fast` | Stop after the first failure |
| `--json` | Write machine-readable summary to stdout (in addition to the log file) |
| `--build` | Run `npm run build` before packing (default: skip build, warn if `dist/` looks stale) |
| `--no-cleanup` | Skip global teardown; keep `.e2e-scratch/` intact; implies `--keep-home` |

### Stubbed for later (prints "not yet implemented" if used)

| Argument | Planned behavior |
|---|---|
| `--priority P0\|P1\|P2\|P3` | Filter tests by priority field |
| `--tag <tag>` | Filter by tag |
| `--filter <regex>` | Filter test titles/ids by regex |
| `--repeat N` | Re-run each test N times (flakiness detection) |
| `--parallel N` | Run N tests concurrently |
| `--timeout-scale F` | Multiply all timeouts by factor F (useful on slow CI) |
| `--report-dir <path>` | Override the log output directory |

---

## Isolation model

Every test gets a fresh, isolated `CRONTICK_HOME`:

- Path: `.e2e-scratch/crontick-home/<test-id>/`
- Created before the test's setup steps run; deleted after teardown (unless `--keep-home`).
- **Safety guard:** before any process is spawned, `assertSafeHome(testHome, scratchDir)` asserts the home path is strictly inside `.e2e-scratch/`. If not, the test aborts immediately. Real user data (your actual `CRONTICK_HOME`) is **never touched**.
- After each test's checks run (or fail), the harness: (1) runs any `cleanup` steps from the test definition; (2) kills the daemon (reads `daemon.pid`, sends SIGTERM then SIGKILL); (3) removes the per-test home.

The installed crontick package itself (under `.e2e-scratch/node_modules/`) is reused across runs if the version matches — only a new `npm pack` + install is triggered when `package.json` version changes.

`.e2e-scratch/` is gitignored and should never be committed.

---

## Where logs go

Each harness run writes to `.e2e-scratch/logs/<YYYY-MM-DDTHH-mm-ss>/`:

| File | Contents |
|---|---|
| `run-summary.json` | Machine-readable JSON: totals, per-test status, durations, check results |
| `run.log` | Full human-readable log of the run |
| `<test-id>.log` | Per-test stdout/stderr for all invocations |

The `--json` flag additionally writes the `run-summary.json` content to stdout.

---

## `tests.json` schema (brief)

`tests/integration/tests.json` is the canonical test-definition file. Top-level shape:

```json
{ "version": 1, "tests": [ /* TestEntry[] */ ] }
```

Key `TestEntry` fields:

| Field | Description |
|---|---|
| `id` | Unique identifier in `CT-AREA-NNN` format |
| `seq` | Sort key (multiples of 10; gap slots reserved for insertions) |
| `title` | Human-readable description |
| `area` | Area group: `install`, `daemon`, `script`, `exec`, `prompt`, `sched`, `job`, `run`, `log`, `err`, `cfg`, `parity`, `clean`, … |
| `surface` | Array of `"cli"`, `"api"`, `"mcp"` — which surfaces this test exercises |
| `priority` | `P0`–`P3` criticality |
| `tier` | `"smoke"` \| `"tier1"` \| `"tier2"` \| `"tier3"` |
| `slow` | `true` if the test takes >30s (Tier 3+ only) |
| `knownDefect` | CTD id string if failure is expected; `null` otherwise |
| `skipOn` | Platform list `["linux","darwin","win32"]` — test is skipped on these |
| `setup` | Steps to run before invocations (same shape as invocations, no checks) |
| `invocations` | One or more surface invocations (`cli`/`api`/`mcp`) |
| `checks` | Ordered assertions to evaluate after invocations complete |
| `cleanup` | Steps to run after checks (always, even on failure) |
| `pollJobUntilTerminal` | `{ jobId, timeoutSec }` — poll for run completion before checks |

---

## Implemented check types

| Type | What it asserts |
|---|---|
| `exitCodeEquals` | CLI exit code equals `expectedCode` |
| `stdoutContains` | CLI stdout includes `substring` (optional `caseSensitive`) |
| `stdoutNotContains` | CLI stdout does NOT include `forbidden` |
| `stderrContains` | CLI stderr includes `substring` |
| `stdoutJsonPathEquals` | CLI stdout parsed as JSON; `jsonPath` deep-equals `expectedValue` |
| `stdoutJsonArrayLength` | CLI stdout parsed as JSON array; length equals `expectedLength` |
| `stdoutJsonArrayContains` | JSON array stdout contains all `expectedItems` |
| `stdoutJsonArrayNotContains` | JSON array stdout contains none of `forbiddenItems` |
| `apiResultJsonPathEquals` | API invocation return value at `jsonPath` deep-equals `expectedValue` |
| `mcpToolResultJsonPath` | MCP tool result text (parsed as JSON) at `jsonPath` deep-equals `expectedValue` |
| `fileExists` | File/directory at `pathTemplate` exists |
| `fileNotExists` | Path does NOT exist |
| `fileContentEquals` | File text content equals `expected` (trimmed by default) |
| `fileContentContains` | File text content includes `substring` |
| `runStatusEquals` | `runs list --job <jobId>` → `[runIndex].status === expectedStatus` |
| `runExitCodeEquals` | `runs list --job <jobId>` → `[runIndex].exitCode === expectedExitCode` |
| `runErrorMatches` | `runs list --job <jobId>` → `[runIndex].error` matches regex `pattern` |
| `runLogContains` | `logs <runId>` stdout+stderr contains `substring` |
| `crossSurfaceFieldEquals` | Same `jsonPath` value across multiple named invocation `refs` |
| `daemonHealthOk` | `GET http://127.0.0.1:<port>/health` returns `{ ok: true }` |

`pathTemplate` and other string params support `${VAR}` expansion:
`${SCRATCH_HOME}`, `${SCRATCH_WORK}`, `${SCRATCH_ROOT}`, `${PACKAGE_VERSION}`, `${MOCK_ENGINE_PATH}`, `${REPO_ROOT}`.

---

## How to add a new test

1. **Pick a `seq` value** in the appropriate area range (see design §9.1). Use a gap slot between existing entries or append above 1300 for a new area. `seq` must be unique.

2. **Choose an `id`** in `CT-<AREA>-<NNN>` format (e.g. `CT-DAEMON-015`).

3. **Add the entry** to the `tests` array in `tests.json`. Minimum required fields:
   ```json
   {
     "id": "CT-DAEMON-015",
     "seq": 150,
     "title": "daemon restart preserves job list",
     "area": "daemon",
     "surface": ["cli"],
     "priority": "P1",
     "tier": "tier1",
     "slow": false,
     "invocations": [ ... ],
     "checks": [ ... ]
   }
   ```

4. **Write invocations and checks** using the check types listed above.
   - CLI invocations: `"surface": "cli", "command": ["daemon", "status", "--json"]`
   - API invocations: `"surface": "api", "script": "const c = crontick.createClient(); return await c.daemonStatus();"`
   - MCP invocations: `"surface": "mcp", "tool": "crontick_daemon_status", "args": {}`

5. **Mark `skipOn`** if the test is platform-specific (e.g. `["linux","darwin"]` for PowerShell tests).

6. **Run it locally** to verify:
   ```sh
   node tests/integration/run-harness.mjs --id CT-DAEMON-015
   ```

7. **No code changes needed** unless your test uses a new check type (see below).

---

## How to add a new check type

1. **Add a new `case`** to the `switch` in `check-engine.mjs`:
   ```js
   case 'myNewCheck': {
     const { param1, param2 } = params;
     // ... assertion logic
     // throw new Error('descriptive message') on failure
     break;
   }
   ```

2. **Register the type name** in the `KNOWN_CHECK_TYPES` set at the top of `check-engine.mjs`:
   ```js
   export const KNOWN_CHECK_TYPES = new Set([
     // ... existing types ...
     'myNewCheck',
   ]);
   ```
   The harness validates all check types at startup and fails fast with a clear error if an unknown type is found in `tests.json`.

3. **Add a test** in `tests.json` that exercises the new check type (see "How to add a new test" above).

4. **Document the type** in the check-type table in this README and in `docs/internals/` if applicable.

---

## GitHub Actions workflow

`.github/workflows/e2e.yml` runs this harness on demand (via `workflow_dispatch`) or on a nightly schedule. It is **not** referenced by `ci.yml` or `release.yml` and does not block PRs.

To trigger manually from GitHub Actions UI, go to **Actions → E2E Integration Harness → Run workflow** and optionally specify a tier (default: `tier1`). Logs are uploaded as artifacts per OS/node matrix entry.
