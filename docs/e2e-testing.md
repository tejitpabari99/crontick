# End-to-End (E2E) Integration Testing

The E2E integration harness lives in `tests/integration/` and is an on-demand complement to
the vitest unit suite. It validates crontick as a real end-user would experience it.

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
| Test definitions | TypeScript/vitest | JSON (`tests/integration/tests.json`) |

The harness builds and packs the **real package**, installs it into an isolated scratch directory,
and drives CLI, API, and MCP surfaces exactly as a user would. It never touches your actual
`CRONTICK_HOME` or any global npm state.

---

## Prerequisites

- Node.js ≥ 22.5 (same requirement as the package itself).
- No manual build step is required: by default the harness reuses a prior `dist/` build and warns
  if it looks stale. Pass `--build` to trigger `npm run build` automatically before packing.

---

## Running the harness

```powershell
# Smoke tier: 6 tests, <45s — no mock-engine setup required
npm run e2e:smoke

# Tier 1: all ~47 tests
npm run e2e

# One specific test
node tests/integration/run-harness.mjs --id CT-DAEMON-001

# Show what Tier 1 would run without executing
node tests/integration/run-harness.mjs --tier tier1 --dry-run

# List tests in the smoke tier with metadata
node tests/integration/run-harness.mjs --tier smoke --list
```

`npm run e2e` and `npm run e2e:smoke` are aliases for `node tests/integration/run-harness.mjs`
with appropriate flags pre-set.

---

## CLI flags

### Implemented

| Flag | Description |
|------|-------------|
| `--start N` | Run tests with `seq >= N` |
| `--end M` | Run tests with `seq <= M`; combine with `--start` for a range |
| `--id CT-X-NNN` | Run exactly one test by id (overrides range/tier filters) |
| `--tier smoke\|tier1\|tier2\|tier3` | Run tests at this tier and all lower tiers (smoke ⊂ tier1 ⊂ tier2 ⊂ tier3) |
| `--area <area>` | Filter by area (e.g. `install`, `daemon`, `script`, `exec`, `prompt`, `parity`) |
| `--surface cli\|api\|mcp` | Filter to tests whose `surface` array includes the given value |
| `--list` | Print test IDs, titles, tiers, and platform-skip status; exit 0 without running |
| `--dry-run` | Print what would run; exit 0 without running |
| `--keep-home` | Skip teardown of per-test `CRONTICK_HOME` dirs (useful for debugging) |
| `--fail-fast` | Stop after the first failure |
| `--json` | Write machine-readable summary to stdout (in addition to the log file) |
| `--build` | Run `npm run build` before packing |
| `--no-cleanup` | Skip global teardown; keep `.e2e-scratch/` intact; implies `--keep-home` |

---

## Isolation guarantee

Each test runs in a fully isolated environment:

- Per-test `CRONTICK_HOME`: `.e2e-scratch/crontick-home/<test-id>/` — created fresh before setup,
  deleted after teardown (unless `--keep-home`).
- Safety guard: if the computed home path escapes `.e2e-scratch/`, the test aborts immediately.
  **Your real `CRONTICK_HOME` is never touched.**
- The installed package (`.e2e-scratch/node_modules/`) is reused across runs when the version
  matches; a fresh `npm pack` + install is only triggered when `package.json` version changes.
- `.e2e-scratch/` is gitignored and never committed.

---

## Where logs go

Each run writes to `.e2e-scratch/logs/<YYYY-MM-DDTHH-mm-ss>/`:

| File | Contents |
|------|-------------|
| `run-summary.json` | Machine-readable totals, per-test status, durations, check results |
| `run.log` | Full human-readable run log |
| `<test-id>.log` | Per-test stdout/stderr for all invocations |

`--json` additionally writes `run-summary.json` content to stdout.

---

## Adding tests and check types

See [`tests/integration/README.md`](../tests/integration/README.md) for the full guide:
schema reference, how to add a new test, how to add a new check type, the check-type catalogue,
and the `tests.json` field reference.
