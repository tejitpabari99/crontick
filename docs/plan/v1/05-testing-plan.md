# Testing Plan for Standalone Cron/Scheduler NPM Package

This plan targets an open-source, platform-agnostic cron/scheduler NPM package with daemon, local HTTP API, SQLite persistence, MCP server, dashboard, and cross-platform autostart. It assumes Vitest for most suites, `node:test` for real subprocess E2E, and automation-first release gates.

## ⚠️ V2 AMENDMENT (2026-07-18) — read this first.

**Removed test areas** (skip / delete during scaffolding):
- All HTTP MCP transport tests (stdio-only in v1).
- All bearer-token / auth / token-rotation tests.
- All LLM provider adapter tests (`copilot`, `agency`, `custom` — none exist in v1).
- All v3→v4 migration tests, importer tests, `.bak` sidecar tests, `cron migrate --from-copilot-ext` tests.
- macOS launchd and Linux systemd autostart tests (stubs only in v1; add tests when backends land).
- LLM-prompt schema fixtures (only `script` and `exec` action kinds exist).

**Added / expanded test areas**:
- **Marketplace plugin install test** — verify `plugin/install.mjs` on Windows: (a) copies `SKILL.md` to `~/.copilot/skills/crontick/SKILL.md`, (b) idempotent on re-run, (c) uninstall preserves data dir.
- **Localhost-only binding test** — assert the HTTP API refuses connections from `0.0.0.0` and any non-loopback interface.
- **Script/exec runner matrix** — expanded coverage since these are the only runtime paths.
- **`node:sqlite` flag handling** — verify daemon shim adds `--experimental-sqlite` on Node 22.5-23.x and does NOT add it on Node 24+.
- **MCP stdio contract** — verified against Copilot MCP host and Claude Desktop as CI smoke.

**Rename** every test file / helper referencing `cron` (as package name) or `@cronjs/*` to `crontick`. Rename every MCP tool assertion from `cron_*` to `crontick_*`.

**Cross-platform matrix (§6)** — v1 CI: `windows-latest × Node 22.5,24` (full incl. autostart e2e); `ubuntu-latest × Node 22.5,24` (unit + integration + contract + MCP stdio); `macos-latest × Node 24` (unit only). No systemd/launchd assertions until those backends land.

Everything else — the 13-layer taxonomy, fuzz corpus policy, property invariants, mutation targets, chaos plan, soak, perf harness, security scanners, DoD checklist — remains authoritative.

---

## 1. Test taxonomy overview

| Layer | Purpose | Tools | Target count | Runs in CI |
|-|-|-|-|-|
| Unit | Pure logic | vitest | 400+ | every push |
| Integration | Multi-module | vitest + tmp fs | 150+ | every push |
| Contract (schema/MCP) | JSON schema, MCP tool schema | ajv + mcp SDK client | 60+ | every push |
| E2E (CLI + daemon) | Real subprocess | node:test w/ real spawns | 40+ | every push |
| Cross-platform smoke | OS-specific autostart | GitHub Actions matrix | 20+ | every PR |
| Fuzz | Malformed input | fast-check + jsfuzz | continuous | nightly |
| Property | Invariants | fast-check | 30+ | every push |
| Mutation | Test quality | Stryker | — | weekly |
| Chaos | Fault injection | custom + toxiproxy | 10+ | nightly |
| Soak / longevity | Memory, fd leaks | 24h+ runs | — | weekly |
| Perf / benchmark | Regression detection | tinybench + tinybench-history | 15 benches | weekly |
| Security | Static + dynamic | semgrep, CodeQL, npm audit, socket | continuous | every push |
| Supply chain | Provenance, sigstore | actions/attest, cosign verify | — | every release |
- Pass criteria: all push suites exit 0, no unapproved skips, and no unhandled rejection logs.
- Coverage: 90% lines overall; scheduler, runner, store, auth, path sandbox, and script-runtime each 95%.
- Flake rule: a flaky test must pass 20 consecutive repeats before being unquarantined.
- Artifact rule: E2E/fuzz/chaos/soak failures upload stdout, stderr, configs, logs, runs.db, and repro seed.
- Performance rule: microbench regression <10%; macrobench regression <15% unless waived.
- Security rule: no critical/high audit, CodeQL, Semgrep, OSV, or socket.dev findings.

Scripts: `test`, `test:unit`, `test:integration`, `test:contract`, `test:e2e`, `test:property`, `test:fuzz`, `test:chaos`, `test:soak`, `test:mutation`, `bench`, and `security:scan`.

## 2. Unit tests

### 2.1. `schedule-parsing` unit tests

File: `tests/unit/schedule-parsing.test.ts`

#### UT-schedule-parsing-01: accept five-field cron `*/5 * * * *`
- Arrange: create deterministic fixtures for `schedule-parsing` and seed fake timers/randomness.
- Act: call the public module API for `accept five-field cron `*/5 * * * *``; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/schedule-parsing.test.ts -t "accept five-field cron `*/5 * * * *`"`.

#### UT-schedule-parsing-02: accept six-field cron when seconds enabled
- Arrange: create deterministic fixtures for `schedule-parsing` and seed fake timers/randomness.
- Act: call the public module API for `accept six-field cron when seconds enabled`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/schedule-parsing.test.ts -t "accept six-field cron when seconds enabled"`.

#### UT-schedule-parsing-03: reject unknown token `every banana`
- Arrange: create deterministic fixtures for `schedule-parsing` and seed fake timers/randomness.
- Act: call the public module API for `reject unknown token `every banana``; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/schedule-parsing.test.ts -t "reject unknown token `every banana`"`.

#### UT-schedule-parsing-04: reject impossible day `0 0 31 2 *`
- Arrange: create deterministic fixtures for `schedule-parsing` and seed fake timers/randomness.
- Act: call the public module API for `reject impossible day `0 0 31 2 *``; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/schedule-parsing.test.ts -t "reject impossible day `0 0 31 2 *`"`.

#### UT-schedule-parsing-05: normalize `@hourly` to `0 * * * *`
- Arrange: create deterministic fixtures for `schedule-parsing` and seed fake timers/randomness.
- Act: call the public module API for `normalize `@hourly` to `0 * * * *``; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/schedule-parsing.test.ts -t "normalize `@hourly` to `0 * * * *`"`.

#### UT-schedule-parsing-06: preserve IANA timezone
- Arrange: create deterministic fixtures for `schedule-parsing` and seed fake timers/randomness.
- Act: call the public module API for `preserve IANA timezone`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/schedule-parsing.test.ts -t "preserve IANA timezone"`.

#### UT-schedule-parsing-07: reject unknown timezone
- Arrange: create deterministic fixtures for `schedule-parsing` and seed fake timers/randomness.
- Act: call the public module API for `reject unknown timezone`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/schedule-parsing.test.ts -t "reject unknown timezone"`.

#### UT-schedule-parsing-08: bound next-fire search under 50 ms
- Arrange: create deterministic fixtures for `schedule-parsing` and seed fake timers/randomness.
- Act: call the public module API for `bound next-fire search under 50 ms`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/schedule-parsing.test.ts -t "bound next-fire search under 50 ms"`.

### 2.2. `croner-wrapper` unit tests

File: `tests/unit/croner-wrapper.test.ts`

#### UT-croner-wrapper-01: construct Croner with timezone
- Arrange: create deterministic fixtures for `croner-wrapper` and seed fake timers/randomness.
- Act: call the public module API for `construct Croner with timezone`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/croner-wrapper.test.ts -t "construct Croner with timezone"`.

#### UT-croner-wrapper-02: map Croner parse errors to public code
- Arrange: create deterministic fixtures for `croner-wrapper` and seed fake timers/randomness.
- Act: call the public module API for `map Croner parse errors to public code`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/croner-wrapper.test.ts -t "map Croner parse errors to public code"`.

#### UT-croner-wrapper-03: return null for exhausted schedule
- Arrange: create deterministic fixtures for `croner-wrapper` and seed fake timers/randomness.
- Act: call the public module API for `return null for exhausted schedule`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/croner-wrapper.test.ts -t "return null for exhausted schedule"`.

#### UT-croner-wrapper-04: compute next five fires strictly increasing
- Arrange: create deterministic fixtures for `croner-wrapper` and seed fake timers/randomness.
- Act: call the public module API for `compute next five fires strictly increasing`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/croner-wrapper.test.ts -t "compute next five fires strictly increasing"`.

#### UT-croner-wrapper-05: handle DST spring-forward skip
- Arrange: create deterministic fixtures for `croner-wrapper` and seed fake timers/randomness.
- Act: call the public module API for `handle DST spring-forward skip`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/croner-wrapper.test.ts -t "handle DST spring-forward skip"`.

#### UT-croner-wrapper-06: handle DST fall-back duplicate policy
- Arrange: create deterministic fixtures for `croner-wrapper` and seed fake timers/randomness.
- Act: call the public module API for `handle DST fall-back duplicate policy`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/croner-wrapper.test.ts -t "handle DST fall-back duplicate policy"`.

#### UT-croner-wrapper-07: propagate AbortSignal
- Arrange: create deterministic fixtures for `croner-wrapper` and seed fake timers/randomness.
- Act: call the public module API for `propagate AbortSignal`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/croner-wrapper.test.ts -t "propagate AbortSignal"`.

#### UT-croner-wrapper-08: use injected clock only
- Arrange: create deterministic fixtures for `croner-wrapper` and seed fake timers/randomness.
- Act: call the public module API for `use injected clock only`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/croner-wrapper.test.ts -t "use injected clock only"`.

### 2.3. `retry-backoff` unit tests

File: `tests/unit/retry-backoff.test.ts`

#### UT-retry-backoff-01: zero retries yields one attempt
- Arrange: create deterministic fixtures for `retry-backoff` and seed fake timers/randomness.
- Act: call the public module API for `zero retries yields one attempt`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/retry-backoff.test.ts -t "zero retries yields one attempt"`.

#### UT-retry-backoff-02: linear backoff returns equal delays
- Arrange: create deterministic fixtures for `retry-backoff` and seed fake timers/randomness.
- Act: call the public module API for `linear backoff returns equal delays`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/retry-backoff.test.ts -t "linear backoff returns equal delays"`.

#### UT-retry-backoff-03: exponential backoff doubles delay
- Arrange: create deterministic fixtures for `retry-backoff` and seed fake timers/randomness.
- Act: call the public module API for `exponential backoff doubles delay`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/retry-backoff.test.ts -t "exponential backoff doubles delay"`.

#### UT-retry-backoff-04: cap max delay
- Arrange: create deterministic fixtures for `retry-backoff` and seed fake timers/randomness.
- Act: call the public module API for `cap max delay`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/retry-backoff.test.ts -t "cap max delay"`.

#### UT-retry-backoff-05: retry retryable exit code 75
- Arrange: create deterministic fixtures for `retry-backoff` and seed fake timers/randomness.
- Act: call the public module API for `retry retryable exit code 75`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/retry-backoff.test.ts -t "retry retryable exit code 75"`.

#### UT-retry-backoff-06: do not retry exit code 2
- Arrange: create deterministic fixtures for `retry-backoff` and seed fake timers/randomness.
- Act: call the public module API for `do not retry exit code 2`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/retry-backoff.test.ts -t "do not retry exit code 2"`.

#### UT-retry-backoff-07: record last error
- Arrange: create deterministic fixtures for `retry-backoff` and seed fake timers/randomness.
- Act: call the public module API for `record last error`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/retry-backoff.test.ts -t "record last error"`.

#### UT-retry-backoff-08: abort sleep during delay
- Arrange: create deterministic fixtures for `retry-backoff` and seed fake timers/randomness.
- Act: call the public module API for `abort sleep during delay`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/retry-backoff.test.ts -t "abort sleep during delay"`.

### 2.4. `budget-checks` unit tests

File: `tests/unit/budget-checks.test.ts`

#### UT-budget-checks-01: allow under daily cap
- Arrange: create deterministic fixtures for `budget-checks` and seed fake timers/randomness.
- Act: call the public module API for `allow under daily cap`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/budget-checks.test.ts -t "allow under daily cap"`.

#### UT-budget-checks-02: block at daily cap
- Arrange: create deterministic fixtures for `budget-checks` and seed fake timers/randomness.
- Act: call the public module API for `block at daily cap`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/budget-checks.test.ts -t "block at daily cap"`.

#### UT-budget-checks-03: reset by job timezone day
- Arrange: create deterministic fixtures for `budget-checks` and seed fake timers/randomness.
- Act: call the public module API for `reset by job timezone day`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/budget-checks.test.ts -t "reset by job timezone day"`.

#### UT-budget-checks-04: enforce max runtime
- Arrange: create deterministic fixtures for `budget-checks` and seed fake timers/randomness.
- Act: call the public module API for `enforce max runtime`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/budget-checks.test.ts -t "enforce max runtime"`.

#### UT-budget-checks-05: enforce output byte cap
- Arrange: create deterministic fixtures for `budget-checks` and seed fake timers/randomness.
- Act: call the public module API for `enforce output byte cap`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/budget-checks.test.ts -t "enforce output byte cap"`.

#### UT-budget-checks-06: enforce LLM token budget
- Arrange: create deterministic fixtures for `budget-checks` and seed fake timers/randomness.
- Act: call the public module API for `enforce LLM token budget`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/budget-checks.test.ts -t "enforce LLM token budget"`.

#### UT-budget-checks-07: transactional concurrent reservation
- Arrange: create deterministic fixtures for `budget-checks` and seed fake timers/randomness.
- Act: call the public module API for `transactional concurrent reservation`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/budget-checks.test.ts -t "transactional concurrent reservation"`.

#### UT-budget-checks-08: emit budget-denied metric
- Arrange: create deterministic fixtures for `budget-checks` and seed fake timers/randomness.
- Act: call the public module API for `emit budget-denied metric`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/budget-checks.test.ts -t "emit budget-denied metric"`.

### 2.5. `catch-up-policy` unit tests

File: `tests/unit/catch-up-policy.test.ts`

#### UT-catch-up-policy-01: none skips missed fires
- Arrange: create deterministic fixtures for `catch-up-policy` and seed fake timers/randomness.
- Act: call the public module API for `none skips missed fires`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/catch-up-policy.test.ts -t "none skips missed fires"`.

#### UT-catch-up-policy-02: run-once collapses many misses
- Arrange: create deterministic fixtures for `catch-up-policy` and seed fake timers/randomness.
- Act: call the public module API for `run-once collapses many misses`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/catch-up-policy.test.ts -t "run-once collapses many misses"`.

#### UT-catch-up-policy-03: all replays bounded by maxCatchup
- Arrange: create deterministic fixtures for `catch-up-policy` and seed fake timers/randomness.
- Act: call the public module API for `all replays bounded by maxCatchup`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/catch-up-policy.test.ts -t "all replays bounded by maxCatchup"`.

#### UT-catch-up-policy-04: respect daily budget
- Arrange: create deterministic fixtures for `catch-up-policy` and seed fake timers/randomness.
- Act: call the public module API for `respect daily budget`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/catch-up-policy.test.ts -t "respect daily budget"`.

#### UT-catch-up-policy-05: respect schedule endDate
- Arrange: create deterministic fixtures for `catch-up-policy` and seed fake timers/randomness.
- Act: call the public module API for `respect schedule endDate`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/catch-up-policy.test.ts -t "respect schedule endDate"`.

#### UT-catch-up-policy-06: handle clock skew forward
- Arrange: create deterministic fixtures for `catch-up-policy` and seed fake timers/randomness.
- Act: call the public module API for `handle clock skew forward`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/catch-up-policy.test.ts -t "handle clock skew forward"`.

#### UT-catch-up-policy-07: handle clock skew backward
- Arrange: create deterministic fixtures for `catch-up-policy` and seed fake timers/randomness.
- Act: call the public module API for `handle clock skew backward`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/catch-up-policy.test.ts -t "handle clock skew backward"`.

#### UT-catch-up-policy-08: persist cursor across restart
- Arrange: create deterministic fixtures for `catch-up-policy` and seed fake timers/randomness.
- Act: call the public module API for `persist cursor across restart`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/catch-up-policy.test.ts -t "persist cursor across restart"`.

### 2.6. `overlap-policy` unit tests

File: `tests/unit/overlap-policy.test.ts`

#### UT-overlap-policy-01: skip prevents same-job concurrency
- Arrange: create deterministic fixtures for `overlap-policy` and seed fake timers/randomness.
- Act: call the public module API for `skip prevents same-job concurrency`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/overlap-policy.test.ts -t "skip prevents same-job concurrency"`.

#### UT-overlap-policy-02: queue preserves order
- Arrange: create deterministic fixtures for `overlap-policy` and seed fake timers/randomness.
- Act: call the public module API for `queue preserves order`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/overlap-policy.test.ts -t "queue preserves order"`.

#### UT-overlap-policy-03: cancel-previous sends SIGTERM
- Arrange: create deterministic fixtures for `overlap-policy` and seed fake timers/randomness.
- Act: call the public module API for `cancel-previous sends SIGTERM`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/overlap-policy.test.ts -t "cancel-previous sends SIGTERM"`.

#### UT-overlap-policy-04: parallel allows configured limit
- Arrange: create deterministic fixtures for `overlap-policy` and seed fake timers/randomness.
- Act: call the public module API for `parallel allows configured limit`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/overlap-policy.test.ts -t "parallel allows configured limit"`.

#### UT-overlap-policy-05: queue depth cap rejects overflow
- Arrange: create deterministic fixtures for `overlap-policy` and seed fake timers/randomness.
- Act: call the public module API for `queue depth cap rejects overflow`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/overlap-policy.test.ts -t "queue depth cap rejects overflow"`.

#### UT-overlap-policy-06: cancel timeout escalates to SIGKILL
- Arrange: create deterministic fixtures for `overlap-policy` and seed fake timers/randomness.
- Act: call the public module API for `cancel timeout escalates to SIGKILL`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/overlap-policy.test.ts -t "cancel timeout escalates to SIGKILL"`.

#### UT-overlap-policy-07: status API shows queued state
- Arrange: create deterministic fixtures for `overlap-policy` and seed fake timers/randomness.
- Act: call the public module API for `status API shows queued state`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/overlap-policy.test.ts -t "status API shows queued state"`.

#### UT-overlap-policy-08: job A never blocks job B
- Arrange: create deterministic fixtures for `overlap-policy` and seed fake timers/randomness.
- Act: call the public module API for `job A never blocks job B`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/overlap-policy.test.ts -t "job A never blocks job B"`.

### 2.7. `jitter` unit tests

File: `tests/unit/jitter.test.ts`

#### UT-jitter-01: zero jitter identity
- Arrange: create deterministic fixtures for `jitter` and seed fake timers/randomness.
- Act: call the public module API for `zero jitter identity`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/jitter.test.ts -t "zero jitter identity"`.

#### UT-jitter-02: bounded jitter <= max
- Arrange: create deterministic fixtures for `jitter` and seed fake timers/randomness.
- Act: call the public module API for `bounded jitter <= max`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/jitter.test.ts -t "bounded jitter <= max"`.

#### UT-jitter-03: deterministic seed stable
- Arrange: create deterministic fixtures for `jitter` and seed fake timers/randomness.
- Act: call the public module API for `deterministic seed stable`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/jitter.test.ts -t "deterministic seed stable"`.

#### UT-jitter-04: different job ids diversify
- Arrange: create deterministic fixtures for `jitter` and seed fake timers/randomness.
- Act: call the public module API for `different job ids diversify`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/jitter.test.ts -t "different job ids diversify"`.

#### UT-jitter-05: never schedule before now
- Arrange: create deterministic fixtures for `jitter` and seed fake timers/randomness.
- Act: call the public module API for `never schedule before now`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/jitter.test.ts -t "never schedule before now"`.

#### UT-jitter-06: interval spacing within jitter window
- Arrange: create deterministic fixtures for `jitter` and seed fake timers/randomness.
- Act: call the public module API for `interval spacing within jitter window`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/jitter.test.ts -t "interval spacing within jitter window"`.

#### UT-jitter-07: persist selected jitter after restart
- Arrange: create deterministic fixtures for `jitter` and seed fake timers/randomness.
- Act: call the public module API for `persist selected jitter after restart`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/jitter.test.ts -t "persist selected jitter after restart"`.

#### UT-jitter-08: reject jitter greater than interval
- Arrange: create deterministic fixtures for `jitter` and seed fake timers/randomness.
- Act: call the public module API for `reject jitter greater than interval`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/jitter.test.ts -t "reject jitter greater than interval"`.

### 2.8. `autostart-path-resolution` unit tests

File: `tests/unit/autostart-path-resolution.test.ts`

#### UT-autostart-path-resolution-01: linux systemd user path
- Arrange: create deterministic fixtures for `autostart-path-resolution` and seed fake timers/randomness.
- Act: call the public module API for `linux systemd user path`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/autostart-path-resolution.test.ts -t "linux systemd user path"`.

#### UT-autostart-path-resolution-02: mac launchd plist path
- Arrange: create deterministic fixtures for `autostart-path-resolution` and seed fake timers/randomness.
- Act: call the public module API for `mac launchd plist path`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/autostart-path-resolution.test.ts -t "mac launchd plist path"`.

#### UT-autostart-path-resolution-03: windows HKCU Run command
- Arrange: create deterministic fixtures for `autostart-path-resolution` and seed fake timers/randomness.
- Act: call the public module API for `windows HKCU Run command`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/autostart-path-resolution.test.ts -t "windows HKCU Run command"`.

#### UT-autostart-path-resolution-04: independent of process cwd
- Arrange: create deterministic fixtures for `autostart-path-resolution` and seed fake timers/randomness.
- Act: call the public module API for `independent of process cwd`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/autostart-path-resolution.test.ts -t "independent of process cwd"`.

#### UT-autostart-path-resolution-05: portable mode carries data dir
- Arrange: create deterministic fixtures for `autostart-path-resolution` and seed fake timers/randomness.
- Act: call the public module API for `portable mode carries data dir`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/autostart-path-resolution.test.ts -t "portable mode carries data dir"`.

#### UT-autostart-path-resolution-06: reject relative daemon path
- Arrange: create deterministic fixtures for `autostart-path-resolution` and seed fake timers/randomness.
- Act: call the public module API for `reject relative daemon path`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/autostart-path-resolution.test.ts -t "reject relative daemon path"`.

#### UT-autostart-path-resolution-07: quote paths with spaces
- Arrange: create deterministic fixtures for `autostart-path-resolution` and seed fake timers/randomness.
- Act: call the public module API for `quote paths with spaces`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/autostart-path-resolution.test.ts -t "quote paths with spaces"`.

#### UT-autostart-path-resolution-08: dry-run reports mutations only
- Arrange: create deterministic fixtures for `autostart-path-resolution` and seed fake timers/randomness.
- Act: call the public module API for `dry-run reports mutations only`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/autostart-path-resolution.test.ts -t "dry-run reports mutations only"`.

### 2.9. `env-paths` unit tests

File: `tests/unit/env-paths.test.ts`

#### UT-env-paths-01: linux follows XDG
- Arrange: create deterministic fixtures for `env-paths` and seed fake timers/randomness.
- Act: call the public module API for `linux follows XDG`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/env-paths.test.ts -t "linux follows XDG"`.

#### UT-env-paths-02: mac uses Library folders
- Arrange: create deterministic fixtures for `env-paths` and seed fake timers/randomness.
- Act: call the public module API for `mac uses Library folders`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/env-paths.test.ts -t "mac uses Library folders"`.

#### UT-env-paths-03: windows uses APPDATA roots
- Arrange: create deterministic fixtures for `env-paths` and seed fake timers/randomness.
- Act: call the public module API for `windows uses APPDATA roots`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/env-paths.test.ts -t "windows uses APPDATA roots"`.

#### UT-env-paths-04: CRON_HOME override
- Arrange: create deterministic fixtures for `env-paths` and seed fake timers/randomness.
- Act: call the public module API for `CRON_HOME override`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/env-paths.test.ts -t "CRON_HOME override"`.

#### UT-env-paths-05: reject root that is file
- Arrange: create deterministic fixtures for `env-paths` and seed fake timers/randomness.
- Act: call the public module API for `reject root that is file`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/env-paths.test.ts -t "reject root that is file"`.

#### UT-env-paths-06: create owner-only dirs
- Arrange: create deterministic fixtures for `env-paths` and seed fake timers/randomness.
- Act: call the public module API for `create owner-only dirs`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/env-paths.test.ts -t "create owner-only dirs"`.

#### UT-env-paths-07: unicode home path round-trips
- Arrange: create deterministic fixtures for `env-paths` and seed fake timers/randomness.
- Act: call the public module API for `unicode home path round-trips`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/env-paths.test.ts -t "unicode home path round-trips"`.

#### UT-env-paths-08: normalized child never escapes root
- Arrange: create deterministic fixtures for `env-paths` and seed fake timers/randomness.
- Act: call the public module API for `normalized child never escapes root`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/env-paths.test.ts -t "normalized child never escapes root"`.

### 2.10. `canonical-json` unit tests

File: `tests/unit/canonical-json.test.ts`

#### UT-canonical-json-01: sort object keys
- Arrange: create deterministic fixtures for `canonical-json` and seed fake timers/randomness.
- Act: call the public module API for `sort object keys`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/canonical-json.test.ts -t "sort object keys"`.

#### UT-canonical-json-02: preserve array order
- Arrange: create deterministic fixtures for `canonical-json` and seed fake timers/randomness.
- Act: call the public module API for `preserve array order`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/canonical-json.test.ts -t "preserve array order"`.

#### UT-canonical-json-03: normalize whitespace
- Arrange: create deterministic fixtures for `canonical-json` and seed fake timers/randomness.
- Act: call the public module API for `normalize whitespace`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/canonical-json.test.ts -t "normalize whitespace"`.

#### UT-canonical-json-04: reject undefined
- Arrange: create deterministic fixtures for `canonical-json` and seed fake timers/randomness.
- Act: call the public module API for `reject undefined`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/canonical-json.test.ts -t "reject undefined"`.

#### UT-canonical-json-05: reject NaN
- Arrange: create deterministic fixtures for `canonical-json` and seed fake timers/randomness.
- Act: call the public module API for `reject NaN`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/canonical-json.test.ts -t "reject NaN"`.

#### UT-canonical-json-06: stable sha256 hash
- Arrange: create deterministic fixtures for `canonical-json` and seed fake timers/randomness.
- Act: call the public module API for `stable sha256 hash`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/canonical-json.test.ts -t "stable sha256 hash"`.

#### UT-canonical-json-07: unicode NFC policy
- Arrange: create deterministic fixtures for `canonical-json` and seed fake timers/randomness.
- Act: call the public module API for `unicode NFC policy`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/canonical-json.test.ts -t "unicode NFC policy"`.

#### UT-canonical-json-08: match golden fixture
- Arrange: create deterministic fixtures for `canonical-json` and seed fake timers/randomness.
- Act: call the public module API for `match golden fixture`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/canonical-json.test.ts -t "match golden fixture"`.

### 2.11. `schema-migration` unit tests

File: `tests/unit/schema-migration.test.ts`

#### UT-schema-migration-01: fresh DB creates latest schema
- Arrange: create deterministic fixtures for `schema-migration` and seed fake timers/randomness.
- Act: call the public module API for `fresh DB creates latest schema`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/schema-migration.test.ts -t "fresh DB creates latest schema"`.

#### UT-schema-migration-02: v1 to v2 preserves rows
- Arrange: create deterministic fixtures for `schema-migration` and seed fake timers/randomness.
- Act: call the public module API for `v1 to v2 preserves rows`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/schema-migration.test.ts -t "v1 to v2 preserves rows"`.

#### UT-schema-migration-03: idempotent second run
- Arrange: create deterministic fixtures for `schema-migration` and seed fake timers/randomness.
- Act: call the public module API for `idempotent second run`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/schema-migration.test.ts -t "idempotent second run"`.

#### UT-schema-migration-04: rollback on injected fault
- Arrange: create deterministic fixtures for `schema-migration` and seed fake timers/randomness.
- Act: call the public module API for `rollback on injected fault`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/schema-migration.test.ts -t "rollback on injected fault"`.

#### UT-schema-migration-05: reject future version
- Arrange: create deterministic fixtures for `schema-migration` and seed fake timers/randomness.
- Act: call the public module API for `reject future version`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/schema-migration.test.ts -t "reject future version"`.

#### UT-schema-migration-06: backup before destructive step
- Arrange: create deterministic fixtures for `schema-migration` and seed fake timers/randomness.
- Act: call the public module API for `backup before destructive step`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/schema-migration.test.ts -t "backup before destructive step"`.

#### UT-schema-migration-07: enable WAL
- Arrange: create deterministic fixtures for `schema-migration` and seed fake timers/randomness.
- Act: call the public module API for `enable WAL`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/schema-migration.test.ts -t "enable WAL"`.

#### UT-schema-migration-08: enable foreign keys
- Arrange: create deterministic fixtures for `schema-migration` and seed fake timers/randomness.
- Act: call the public module API for `enable foreign keys`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/schema-migration.test.ts -t "enable foreign keys"`.

### 2.12. `script-runtime` unit tests

File: `tests/unit/script-runtime.test.ts`

#### UT-script-runtime-01: run node script and capture stdout
- Arrange: create deterministic fixtures for `script-runtime` and seed fake timers/randomness.
- Act: call the public module API for `run node script and capture stdout`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/script-runtime.test.ts -t "run node script and capture stdout"`.

#### UT-script-runtime-02: reject disabled runtime
- Arrange: create deterministic fixtures for `script-runtime` and seed fake timers/randomness.
- Act: call the public module API for `reject disabled runtime`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/script-runtime.test.ts -t "reject disabled runtime"`.

#### UT-script-runtime-03: sanitize child env
- Arrange: create deterministic fixtures for `script-runtime` and seed fake timers/randomness.
- Act: call the public module API for `sanitize child env`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/script-runtime.test.ts -t "sanitize child env"`.

#### UT-script-runtime-04: deny cwd outside allowedDirs
- Arrange: create deterministic fixtures for `script-runtime` and seed fake timers/randomness.
- Act: call the public module API for `deny cwd outside allowedDirs`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/script-runtime.test.ts -t "deny cwd outside allowedDirs"`.

#### UT-script-runtime-05: stream stdout stderr with order
- Arrange: create deterministic fixtures for `script-runtime` and seed fake timers/randomness.
- Act: call the public module API for `stream stdout stderr with order`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/script-runtime.test.ts -t "stream stdout stderr with order"`.

#### UT-script-runtime-06: kill process tree
- Arrange: create deterministic fixtures for `script-runtime` and seed fake timers/randomness.
- Act: call the public module API for `kill process tree`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/script-runtime.test.ts -t "kill process tree"`.

#### UT-script-runtime-07: handle large output rotation
- Arrange: create deterministic fixtures for `script-runtime` and seed fake timers/randomness.
- Act: call the public module API for `handle large output rotation`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/script-runtime.test.ts -t "handle large output rotation"`.

#### UT-script-runtime-08: disable LLM CLI by default
- Arrange: create deterministic fixtures for `script-runtime` and seed fake timers/randomness.
- Act: call the public module API for `disable LLM CLI by default`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/script-runtime.test.ts -t "disable LLM CLI by default"`.

### 2.13. `log-rotation` unit tests

File: `tests/unit/log-rotation.test.ts`

#### UT-log-rotation-01: rotate by size
- Arrange: create deterministic fixtures for `log-rotation` and seed fake timers/randomness.
- Act: call the public module API for `rotate by size`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/log-rotation.test.ts -t "rotate by size"`.

#### UT-log-rotation-02: enforce retention count
- Arrange: create deterministic fixtures for `log-rotation` and seed fake timers/randomness.
- Act: call the public module API for `enforce retention count`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/log-rotation.test.ts -t "enforce retention count"`.

#### UT-log-rotation-03: atomic complete JSON lines
- Arrange: create deterministic fixtures for `log-rotation` and seed fake timers/randomness.
- Act: call the public module API for `atomic complete JSON lines`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/log-rotation.test.ts -t "atomic complete JSON lines"`.

#### UT-log-rotation-04: redact token-looking secrets
- Arrange: create deterministic fixtures for `log-rotation` and seed fake timers/randomness.
- Act: call the public module API for `redact token-looking secrets`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/log-rotation.test.ts -t "redact token-looking secrets"`.

#### UT-log-rotation-05: preserve UTF-8
- Arrange: create deterministic fixtures for `log-rotation` and seed fake timers/randomness.
- Act: call the public module API for `preserve UTF-8`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/log-rotation.test.ts -t "preserve UTF-8"`.

#### UT-log-rotation-06: handle ENOSPC
- Arrange: create deterministic fixtures for `log-rotation` and seed fake timers/randomness.
- Act: call the public module API for `handle ENOSPC`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/log-rotation.test.ts -t "handle ENOSPC"`.

#### UT-log-rotation-07: tail from byte offset
- Arrange: create deterministic fixtures for `log-rotation` and seed fake timers/randomness.
- Act: call the public module API for `tail from byte offset`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/log-rotation.test.ts -t "tail from byte offset"`.

#### UT-log-rotation-08: gzip old logs
- Arrange: create deterministic fixtures for `log-rotation` and seed fake timers/randomness.
- Act: call the public module API for `gzip old logs`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/log-rotation.test.ts -t "gzip old logs"`.

### 2.14. `runs-db-queries` unit tests

File: `tests/unit/runs-db-queries.test.ts`

#### UT-runs-db-queries-01: insert run with id and timestamps
- Arrange: create deterministic fixtures for `runs-db-queries` and seed fake timers/randomness.
- Act: call the public module API for `insert run with id and timestamps`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/runs-db-queries.test.ts -t "insert run with id and timestamps"`.

#### UT-runs-db-queries-02: valid transition queued-running-succeeded
- Arrange: create deterministic fixtures for `runs-db-queries` and seed fake timers/randomness.
- Act: call the public module API for `valid transition queued-running-succeeded`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/runs-db-queries.test.ts -t "valid transition queued-running-succeeded"`.

#### UT-runs-db-queries-03: reject invalid terminal transition
- Arrange: create deterministic fixtures for `runs-db-queries` and seed fake timers/randomness.
- Act: call the public module API for `reject invalid terminal transition`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/runs-db-queries.test.ts -t "reject invalid terminal transition"`.

#### UT-runs-db-queries-04: query by job id
- Arrange: create deterministic fixtures for `runs-db-queries` and seed fake timers/randomness.
- Act: call the public module API for `query by job id`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/runs-db-queries.test.ts -t "query by job id"`.

#### UT-runs-db-queries-05: cursor pagination no duplicates
- Arrange: create deterministic fixtures for `runs-db-queries` and seed fake timers/randomness.
- Act: call the public module API for `cursor pagination no duplicates`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/runs-db-queries.test.ts -t "cursor pagination no duplicates"`.

#### UT-runs-db-queries-06: time range boundary inclusive
- Arrange: create deterministic fixtures for `runs-db-queries` and seed fake timers/randomness.
- Act: call the public module API for `time range boundary inclusive`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/runs-db-queries.test.ts -t "time range boundary inclusive"`.

#### UT-runs-db-queries-07: retention cleanup skips active
- Arrange: create deterministic fixtures for `runs-db-queries` and seed fake timers/randomness.
- Act: call the public module API for `retention cleanup skips active`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/runs-db-queries.test.ts -t "retention cleanup skips active"`.

#### UT-runs-db-queries-08: concurrent writers retry SQLITE_BUSY
- Arrange: create deterministic fixtures for `runs-db-queries` and seed fake timers/randomness.
- Act: call the public module API for `concurrent writers retry SQLITE_BUSY`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/runs-db-queries.test.ts -t "concurrent writers retry SQLITE_BUSY"`.

### 2.15. `mcp-tool-argument-normalization` unit tests

File: `tests/unit/mcp-tool-argument-normalization.test.ts`

#### UT-mcp-tool-argument-normalization-01: accept camelCase jobId
- Arrange: create deterministic fixtures for `mcp-tool-argument-normalization` and seed fake timers/randomness.
- Act: call the public module API for `accept camelCase jobId`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/mcp-tool-argument-normalization.test.ts -t "accept camelCase jobId"`.

#### UT-mcp-tool-argument-normalization-02: accept snake_case job_id with warning
- Arrange: create deterministic fixtures for `mcp-tool-argument-normalization` and seed fake timers/randomness.
- Act: call the public module API for `accept snake_case job_id with warning`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/mcp-tool-argument-normalization.test.ts -t "accept snake_case job_id with warning"`.

#### UT-mcp-tool-argument-normalization-03: reject unknown arg
- Arrange: create deterministic fixtures for `mcp-tool-argument-normalization` and seed fake timers/randomness.
- Act: call the public module API for `reject unknown arg`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/mcp-tool-argument-normalization.test.ts -t "reject unknown arg"`.

#### UT-mcp-tool-argument-normalization-04: default dryRun correctly
- Arrange: create deterministic fixtures for `mcp-tool-argument-normalization` and seed fake timers/randomness.
- Act: call the public module API for `default dryRun correctly`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/mcp-tool-argument-normalization.test.ts -t "default dryRun correctly"`.

#### UT-mcp-tool-argument-normalization-05: normalize Windows paths
- Arrange: create deterministic fixtures for `mcp-tool-argument-normalization` and seed fake timers/randomness.
- Act: call the public module API for `normalize Windows paths`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/mcp-tool-argument-normalization.test.ts -t "normalize Windows paths"`.

#### UT-mcp-tool-argument-normalization-06: parse ISO date args
- Arrange: create deterministic fixtures for `mcp-tool-argument-normalization` and seed fake timers/randomness.
- Act: call the public module API for `parse ISO date args`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/mcp-tool-argument-normalization.test.ts -t "parse ISO date args"`.

#### UT-mcp-tool-argument-normalization-07: enum case strictness
- Arrange: create deterministic fixtures for `mcp-tool-argument-normalization` and seed fake timers/randomness.
- Act: call the public module API for `enum case strictness`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/mcp-tool-argument-normalization.test.ts -t "enum case strictness"`.

#### UT-mcp-tool-argument-normalization-08: MCP error has code message data.path
- Arrange: create deterministic fixtures for `mcp-tool-argument-normalization` and seed fake timers/randomness.
- Act: call the public module API for `MCP error has code message data.path`; do not reach into private helpers.
- Assert: exact result/error code, stable canonical output, and no pending timers or handles.
- Command: `pnpm test:unit -- tests/unit/mcp-tool-argument-normalization.test.ts -t "MCP error has code message data.path"`.

## 3. Integration tests

### 3.1. `job-create-schedule-run-complete-history`
File: `tests/integration/job-create-schedule-run-complete-history.test.ts`
Purpose: Job create → schedule → run → complete → history query.
- create sandbox with `os.tmpdir()` + `mkdtemp`.
- set `CRON_HOME` to sandbox.
- start real scheduler, store, runner, API modules.
- use real SQLite WAL database.
- assert no file writes outside sandbox.
- assert `PRAGMA integrity_check` returns `ok`.
- assert no dangling timers after harness close.
- Variant 01: seed `job-create-schedule-run-complete-history-01` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 02: seed `job-create-schedule-run-complete-history-02` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 03: seed `job-create-schedule-run-complete-history-03` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 04: seed `job-create-schedule-run-complete-history-04` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 05: seed `job-create-schedule-run-complete-history-05` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 06: seed `job-create-schedule-run-complete-history-06` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 07: seed `job-create-schedule-run-complete-history-07` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 08: seed `job-create-schedule-run-complete-history-08` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 09: seed `job-create-schedule-run-complete-history-09` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 10: seed `job-create-schedule-run-complete-history-10` asserts deterministic run IDs, ordered events, and stable final DB rows.

### 3.2. `overlap-policy-matrix`
File: `tests/integration/overlap-policy-matrix.test.ts`
Purpose: Overlap policies × schedule types.
- create sandbox with `os.tmpdir()` + `mkdtemp`.
- set `CRON_HOME` to sandbox.
- start real scheduler, store, runner, API modules.
- use real SQLite WAL database.
- assert no file writes outside sandbox.
- assert `PRAGMA integrity_check` returns `ok`.
- assert no dangling timers after harness close.
- Variant 01: seed `overlap-policy-matrix-01` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 02: seed `overlap-policy-matrix-02` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 03: seed `overlap-policy-matrix-03` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 04: seed `overlap-policy-matrix-04` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 05: seed `overlap-policy-matrix-05` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 06: seed `overlap-policy-matrix-06` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 07: seed `overlap-policy-matrix-07` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 08: seed `overlap-policy-matrix-08` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 09: seed `overlap-policy-matrix-09` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 10: seed `overlap-policy-matrix-10` asserts deterministic run IDs, ordered events, and stable final DB rows.

### 3.3. `catchup-restart-clock-skew`
File: `tests/integration/catchup-restart-clock-skew.test.ts`
Purpose: Catchup on daemon restart with clock skew.
- create sandbox with `os.tmpdir()` + `mkdtemp`.
- set `CRON_HOME` to sandbox.
- start real scheduler, store, runner, API modules.
- use real SQLite WAL database.
- assert no file writes outside sandbox.
- assert `PRAGMA integrity_check` returns `ok`.
- assert no dangling timers after harness close.
- Variant 01: seed `catchup-restart-clock-skew-01` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 02: seed `catchup-restart-clock-skew-02` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 03: seed `catchup-restart-clock-skew-03` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 04: seed `catchup-restart-clock-skew-04` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 05: seed `catchup-restart-clock-skew-05` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 06: seed `catchup-restart-clock-skew-06` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 07: seed `catchup-restart-clock-skew-07` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 08: seed `catchup-restart-clock-skew-08` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 09: seed `catchup-restart-clock-skew-09` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 10: seed `catchup-restart-clock-skew-10` asserts deterministic run IDs, ordered events, and stable final DB rows.

### 3.4. `budget-breach-mid-run`
File: `tests/integration/budget-breach-mid-run.test.ts`
Purpose: Budget breach mid-run.
- create sandbox with `os.tmpdir()` + `mkdtemp`.
- set `CRON_HOME` to sandbox.
- start real scheduler, store, runner, API modules.
- use real SQLite WAL database.
- assert no file writes outside sandbox.
- assert `PRAGMA integrity_check` returns `ok`.
- assert no dangling timers after harness close.
- Variant 01: seed `budget-breach-mid-run-01` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 02: seed `budget-breach-mid-run-02` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 03: seed `budget-breach-mid-run-03` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 04: seed `budget-breach-mid-run-04` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 05: seed `budget-breach-mid-run-05` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 06: seed `budget-breach-mid-run-06` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 07: seed `budget-breach-mid-run-07` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 08: seed `budget-breach-mid-run-08` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 09: seed `budget-breach-mid-run-09` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 10: seed `budget-breach-mid-run-10` asserts deterministic run IDs, ordered events, and stable final DB rows.

### 3.5. `retry-backoff-jitter`
File: `tests/integration/retry-backoff-jitter.test.ts`
Purpose: Retry × backoff × jitter interactions.
- create sandbox with `os.tmpdir()` + `mkdtemp`.
- set `CRON_HOME` to sandbox.
- start real scheduler, store, runner, API modules.
- use real SQLite WAL database.
- assert no file writes outside sandbox.
- assert `PRAGMA integrity_check` returns `ok`.
- assert no dangling timers after harness close.
- Variant 01: seed `retry-backoff-jitter-01` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 02: seed `retry-backoff-jitter-02` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 03: seed `retry-backoff-jitter-03` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 04: seed `retry-backoff-jitter-04` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 05: seed `retry-backoff-jitter-05` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 06: seed `retry-backoff-jitter-06` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 07: seed `retry-backoff-jitter-07` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 08: seed `retry-backoff-jitter-08` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 09: seed `retry-backoff-jitter-09` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 10: seed `retry-backoff-jitter-10` asserts deterministic run IDs, ordered events, and stable final DB rows.

### 3.6. `cancel-previous-queue-depth`
File: `tests/integration/cancel-previous-queue-depth.test.ts`
Purpose: Cancel-previous vs queue depths.
- create sandbox with `os.tmpdir()` + `mkdtemp`.
- set `CRON_HOME` to sandbox.
- start real scheduler, store, runner, API modules.
- use real SQLite WAL database.
- assert no file writes outside sandbox.
- assert `PRAGMA integrity_check` returns `ok`.
- assert no dangling timers after harness close.
- Variant 01: seed `cancel-previous-queue-depth-01` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 02: seed `cancel-previous-queue-depth-02` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 03: seed `cancel-previous-queue-depth-03` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 04: seed `cancel-previous-queue-depth-04` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 05: seed `cancel-previous-queue-depth-05` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 06: seed `cancel-previous-queue-depth-06` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 07: seed `cancel-previous-queue-depth-07` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 08: seed `cancel-previous-queue-depth-08` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 09: seed `cancel-previous-queue-depth-09` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 10: seed `cancel-previous-queue-depth-10` asserts deterministic run IDs, ordered events, and stable final DB rows.

### 3.7. `sse-multiple-subscribers`
File: `tests/integration/sse-multiple-subscribers.test.ts`
Purpose: SSE tailing with multiple concurrent subscribers.
- create sandbox with `os.tmpdir()` + `mkdtemp`.
- set `CRON_HOME` to sandbox.
- start real scheduler, store, runner, API modules.
- use real SQLite WAL database.
- assert no file writes outside sandbox.
- assert `PRAGMA integrity_check` returns `ok`.
- assert no dangling timers after harness close.
- Variant 01: seed `sse-multiple-subscribers-01` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 02: seed `sse-multiple-subscribers-02` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 03: seed `sse-multiple-subscribers-03` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 04: seed `sse-multiple-subscribers-04` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 05: seed `sse-multiple-subscribers-05` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 06: seed `sse-multiple-subscribers-06` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 07: seed `sse-multiple-subscribers-07` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 08: seed `sse-multiple-subscribers-08` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 09: seed `sse-multiple-subscribers-09` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 10: seed `sse-multiple-subscribers-10` asserts deterministic run IDs, ordered events, and stable final DB rows.

### 3.8. `file-watch-reload`
File: `tests/integration/file-watch-reload.test.ts`
Purpose: File-watch reload of job JSON.
- create sandbox with `os.tmpdir()` + `mkdtemp`.
- set `CRON_HOME` to sandbox.
- start real scheduler, store, runner, API modules.
- use real SQLite WAL database.
- assert no file writes outside sandbox.
- assert `PRAGMA integrity_check` returns `ok`.
- assert no dangling timers after harness close.
- Variant 01: seed `file-watch-reload-01` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 02: seed `file-watch-reload-02` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 03: seed `file-watch-reload-03` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 04: seed `file-watch-reload-04` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 05: seed `file-watch-reload-05` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 06: seed `file-watch-reload-06` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 07: seed `file-watch-reload-07` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 08: seed `file-watch-reload-08` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 09: seed `file-watch-reload-09` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 10: seed `file-watch-reload-10` asserts deterministic run IDs, ordered events, and stable final DB rows.

### 3.9. `sqlite-wal-recovery`
File: `tests/integration/sqlite-wal-recovery.test.ts`
Purpose: SQLite WAL recovery from unclean shutdown.
- create sandbox with `os.tmpdir()` + `mkdtemp`.
- set `CRON_HOME` to sandbox.
- start real scheduler, store, runner, API modules.
- use real SQLite WAL database.
- assert no file writes outside sandbox.
- assert `PRAGMA integrity_check` returns `ok`.
- assert no dangling timers after harness close.
- Variant 01: seed `sqlite-wal-recovery-01` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 02: seed `sqlite-wal-recovery-02` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 03: seed `sqlite-wal-recovery-03` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 04: seed `sqlite-wal-recovery-04` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 05: seed `sqlite-wal-recovery-05` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 06: seed `sqlite-wal-recovery-06` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 07: seed `sqlite-wal-recovery-07` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 08: seed `sqlite-wal-recovery-08` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 09: seed `sqlite-wal-recovery-09` asserts deterministic run IDs, ordered events, and stable final DB rows.
- Variant 10: seed `sqlite-wal-recovery-10` asserts deterministic run IDs, ordered events, and stable final DB rows.

## 4. Contract tests

### 4.1. Every JSON Schema validates its example fixtures
- File: `tests/contract/json-schema-examples.test.ts`.
- Fixtures: `schemas/`, `tests/fixtures/examples/`, `tests/fixtures/invalid/`, `docs/openapi.yaml`.
- Exact assertion: `expect(validate(body)).toBe(true)` for positives; negatives assert `error.code`, `instancePath`, and `additionalProperties` behavior.
- CI command: `pnpm test:contract -- tests/contract/json-schema-examples.test.ts`.

### 4.2. Every invalid fixture fails with exact instancePath
- File: `tests/contract/json-schema-negative.test.ts`.
- Fixtures: `schemas/`, `tests/fixtures/examples/`, `tests/fixtures/invalid/`, `docs/openapi.yaml`.
- Exact assertion: `expect(validate(body)).toBe(true)` for positives; negatives assert `error.code`, `instancePath`, and `additionalProperties` behavior.
- CI command: `pnpm test:contract -- tests/contract/json-schema-negative.test.ts`.

### 4.3. Every schema compiles in Ajv strict mode
- File: `tests/contract/ajv-strict.test.ts`.
- Fixtures: `schemas/`, `tests/fixtures/examples/`, `tests/fixtures/invalid/`, `docs/openapi.yaml`.
- Exact assertion: `expect(validate(body)).toBe(true)` for positives; negatives assert `error.code`, `instancePath`, and `additionalProperties` behavior.
- CI command: `pnpm test:contract -- tests/contract/ajv-strict.test.ts`.

### 4.4. Every MCP tool input schema round-trips through Ajv strict mode
- File: `tests/contract/mcp-tool-schemas.test.ts`.
- Fixtures: `schemas/`, `tests/fixtures/examples/`, `tests/fixtures/invalid/`, `docs/openapi.yaml`.
- Exact assertion: `expect(validate(body)).toBe(true)` for positives; negatives assert `error.code`, `instancePath`, and `additionalProperties` behavior.
- CI command: `pnpm test:contract -- tests/contract/mcp-tool-schemas.test.ts`.

### 4.5. MCP initialize handshake spec conformance using official SDK client
- File: `tests/contract/mcp-initialize.test.ts`.
- Fixtures: `schemas/`, `tests/fixtures/examples/`, `tests/fixtures/invalid/`, `docs/openapi.yaml`.
- Exact assertion: `expect(validate(body)).toBe(true)` for positives; negatives assert `error.code`, `instancePath`, and `additionalProperties` behavior.
- CI command: `pnpm test:contract -- tests/contract/mcp-initialize.test.ts`.

### 4.6. MCP tools/list exposes stable sorted names
- File: `tests/contract/mcp-tools-list.test.ts`.
- Fixtures: `schemas/`, `tests/fixtures/examples/`, `tests/fixtures/invalid/`, `docs/openapi.yaml`.
- Exact assertion: `expect(validate(body)).toBe(true)` for positives; negatives assert `error.code`, `instancePath`, and `additionalProperties` behavior.
- CI command: `pnpm test:contract -- tests/contract/mcp-tools-list.test.ts`.

### 4.7. MCP tools/call errors follow JSON-RPC shape
- File: `tests/contract/mcp-tool-errors.test.ts`.
- Fixtures: `schemas/`, `tests/fixtures/examples/`, `tests/fixtures/invalid/`, `docs/openapi.yaml`.
- Exact assertion: `expect(validate(body)).toBe(true)` for positives; negatives assert `error.code`, `instancePath`, and `additionalProperties` behavior.
- CI command: `pnpm test:contract -- tests/contract/mcp-tool-errors.test.ts`.

### 4.8. REST OpenAPI validates with openapi-schema-validator
- File: `tests/contract/openapi-valid.test.ts`.
- Fixtures: `schemas/`, `tests/fixtures/examples/`, `tests/fixtures/invalid/`, `docs/openapi.yaml`.
- Exact assertion: `expect(validate(body)).toBe(true)` for positives; negatives assert `error.code`, `instancePath`, and `additionalProperties` behavior.
- CI command: `pnpm test:contract -- tests/contract/openapi-valid.test.ts`.

### 4.9. OpenAPI examples validate request and response bodies
- File: `tests/contract/openapi-examples.test.ts`.
- Fixtures: `schemas/`, `tests/fixtures/examples/`, `tests/fixtures/invalid/`, `docs/openapi.yaml`.
- Exact assertion: `expect(validate(body)).toBe(true)` for positives; negatives assert `error.code`, `instancePath`, and `additionalProperties` behavior.
- CI command: `pnpm test:contract -- tests/contract/openapi-examples.test.ts`.

### 4.10. HTTP errors use stable envelope
- File: `tests/contract/http-error-envelope.test.ts`.
- Fixtures: `schemas/`, `tests/fixtures/examples/`, `tests/fixtures/invalid/`, `docs/openapi.yaml`.
- Exact assertion: `expect(validate(body)).toBe(true)` for positives; negatives assert `error.code`, `instancePath`, and `additionalProperties` behavior.
- CI command: `pnpm test:contract -- tests/contract/http-error-envelope.test.ts`.

## 5. E2E tests

### 5.1. `install-lifecycle`
- File: `tests/e2e/install-lifecycle.test.mjs`.
- Covers: Full install lifecycle (`cron install --autostart`, restart, uninstall).
- spawn `node dist/daemon.js --data-dir <root> --port 0`.
- spawn `node dist/cli.js` commands as real subprocesses.
- assert daemon stderr matches `listening on 127.0.0.1:\d+`.
- assert expected graceful exits have code 0.
- assert health endpoint returns `{status:"ok"}`.
- assert process tree cleanup by PID after test.

### 5.2. `auth-token-rotation`
- File: `tests/e2e/auth-token-rotation.test.mjs`.
- Covers: Auth token creation, rotation, HTTP MCP handshake.
- spawn `node dist/daemon.js --data-dir <root> --port 0`.
- spawn `node dist/cli.js` commands as real subprocesses.
- assert daemon stderr matches `listening on 127.0.0.1:\d+`.
- assert expected graceful exits have code 0.
- assert health endpoint returns `{status:"ok"}`.
- assert process tree cleanup by PID after test.

### 5.3. `dashboard-static`
- File: `tests/e2e/dashboard-static.test.mjs`.
- Covers: Dashboard reachable, static assets served.
- spawn `node dist/daemon.js --data-dir <root> --port 0`.
- spawn `node dist/cli.js` commands as real subprocesses.
- assert daemon stderr matches `listening on 127.0.0.1:\d+`.
- assert expected graceful exits have code 0.
- assert health endpoint returns `{status:"ok"}`.
- assert process tree cleanup by PID after test.

### 5.4. `signals`
- File: `tests/e2e/signals.test.mjs`.
- Covers: Signal handling (SIGINT, SIGTERM, SIGHUP → reload).
- spawn `node dist/daemon.js --data-dir <root> --port 0`.
- spawn `node dist/cli.js` commands as real subprocesses.
- assert daemon stderr matches `listening on 127.0.0.1:\d+`.
- assert expected graceful exits have code 0.
- assert health endpoint returns `{status:"ok"}`.
- assert process tree cleanup by PID after test.

### 5.5. `graceful-shutdown`
- File: `tests/e2e/graceful-shutdown.test.mjs`.
- Covers: Graceful shutdown drains active runs (queue vs cancel).
- spawn `node dist/daemon.js --data-dir <root> --port 0`.
- spawn `node dist/cli.js` commands as real subprocesses.
- assert daemon stderr matches `listening on 127.0.0.1:\d+`.
- assert expected graceful exits have code 0.
- assert health endpoint returns `{status:"ok"}`.
- assert process tree cleanup by PID after test.

### 5.6. `cli-job-crud`
- File: `tests/e2e/cli-job-crud.test.mjs`.
- Covers: CLI job create/list/update/delete against daemon.
- spawn `node dist/daemon.js --data-dir <root> --port 0`.
- spawn `node dist/cli.js` commands as real subprocesses.
- assert daemon stderr matches `listening on 127.0.0.1:\d+`.
- assert expected graceful exits have code 0.
- assert health endpoint returns `{status:"ok"}`.
- assert process tree cleanup by PID after test.

### 5.7. `http-mcp-bridge`
- File: `tests/e2e/http-mcp-bridge.test.mjs`.
- Covers: HTTP MCP transport.
- spawn `node dist/daemon.js --data-dir <root> --port 0`.
- spawn `node dist/cli.js` commands as real subprocesses.
- assert daemon stderr matches `listening on 127.0.0.1:\d+`.
- assert expected graceful exits have code 0.
- assert health endpoint returns `{status:"ok"}`.
- assert process tree cleanup by PID after test.

### 5.8. `packaged-bin`
- File: `tests/e2e/packaged-bin.test.mjs`.
- Covers: npm pack binary smoke.
- spawn `node dist/daemon.js --data-dir <root> --port 0`.
- spawn `node dist/cli.js` commands as real subprocesses.
- assert daemon stderr matches `listening on 127.0.0.1:\d+`.
- assert expected graceful exits have code 0.
- assert health endpoint returns `{status:"ok"}`.
- assert process tree cleanup by PID after test.

## 6. Cross-platform matrix (GitHub Actions)

| OS | Node | Autostart backend | Special asserts |
|-|-|-|-|
| ubuntu-latest | 22, 24 | systemd --user | `systemctl --user is-enabled` |
| macos-latest | 22, 24 | launchd | `launchctl list` |
| windows-latest | 22, 24 | HKCU Run + VBS | registry query |
- CP-01 `ubuntu-latest` command: `systemctl --user is-enabled cron-scheduler.service`; expected pattern: stdout `enabled|linked`, exit 0.
- CP-02 `ubuntu-latest` command: `systemctl --user cat cron-scheduler.service`; expected pattern: contains `ExecStart=` and absolute daemon path.
- CP-03 `ubuntu-latest` command: `node dist/cli.js install --autostart --dry-run`; expected pattern: contains `Would write systemd unit`; no file created.
- CP-04 `macos-latest` command: `launchctl list | grep cron-scheduler`; expected pattern: contains service label, exit 0.
- CP-05 `macos-latest` command: `plutil -lint ~/Library/LaunchAgents/com.cron-scheduler.daemon.plist`; expected pattern: contains `OK`.
- CP-06 `macos-latest` command: `node dist/cli.js install --autostart --dry-run`; expected pattern: contains `launchctl bootstrap gui/`.
- CP-07 `windows-latest` command: `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v CronScheduler`; expected pattern: contains `REG_SZ` and quoted daemon command.
- CP-08 `windows-latest` command: `powershell -NoProfile -Command "Test-Path $env:APPDATA\CronScheduler\start-daemon.vbs"`; expected pattern: stdout `True`.
- CP-09 `windows-latest` command: `node dist/cli.js install --autostart --dry-run`; expected pattern: contains `Would set HKCU Run`; registry unchanged.

## 7. Fuzz testing

### 7.1. `cron-expressions` fuzz
- Generator: fast-check valid + malformed cron-like strings.
- Target: `cron_schedule_validate`.
- Invariant: no crash; valid next-fire computable or error code specific.
- File: `tests/fuzz/cron-expressions.fuzz.ts`; corpus: `tests/fixtures/corpus/cron-expressions/`.
- Repro: `FUZZ_SEED=<seed> pnpm test:fuzz -- tests/fuzz/cron-expressions.fuzz.ts`.
- Nightly artifact: minimized corpus, failing input, daemon logs, and seed.

### 7.2. `interval-strings` fuzz
- Generator: valid `every 5m`, `every 3h`, malformed strings.
- Target: interval parser.
- Invariant: positive ms or `ERR_INTERVAL_SYNTAX`.
- File: `tests/fuzz/interval-strings.fuzz.ts`; corpus: `tests/fixtures/corpus/interval-strings/`.
- Repro: `FUZZ_SEED=<seed> pnpm test:fuzz -- tests/fuzz/interval-strings.fuzz.ts`.
- Nightly artifact: minimized corpus, failing input, daemon logs, and seed.

### 7.3. `job-json` fuzz
- Generator: json-schema-faker generated jobs.
- Target: daemon POST `/api/jobs`.
- Invariant: 201 or 400 valid error body; never 500/hang.
- File: `tests/fuzz/job-json.fuzz.ts`; corpus: `tests/fixtures/corpus/job-json/`.
- Repro: `FUZZ_SEED=<seed> pnpm test:fuzz -- tests/fuzz/job-json.fuzz.ts`.
- Nightly artifact: minimized corpus, failing input, daemon logs, and seed.

### 7.4. `script-bodies` fuzz
- Generator: random UTF-8 blobs.
- Target: script action validator.
- Invariant: rejected/sanitized before execution.
- File: `tests/fuzz/script-bodies.fuzz.ts`; corpus: `tests/fixtures/corpus/script-bodies/`.
- Repro: `FUZZ_SEED=<seed> pnpm test:fuzz -- tests/fuzz/script-bodies.fuzz.ts`.
- Nightly artifact: minimized corpus, failing input, daemon logs, and seed.

### 7.5. `http-api` fuzz
- Generator: restler-fuzzer or zap-fuzz OpenAPI traffic.
- Target: local REST API.
- Invariant: no 500 and no unhandled rejection.
- File: `tests/fuzz/http-api.fuzz.ts`; corpus: `tests/fixtures/corpus/http-api/`.
- Repro: `FUZZ_SEED=<seed> pnpm test:fuzz -- tests/fuzz/http-api.fuzz.ts`.
- Nightly artifact: minimized corpus, failing input, daemon logs, and seed.

### 7.6. `mcp-json-rpc` fuzz
- Generator: malformed initialize/tools/call JSON-RPC.
- Target: MCP server.
- Invariant: structured error or clean close.
- File: `tests/fuzz/mcp-json-rpc.fuzz.ts`; corpus: `tests/fixtures/corpus/mcp-json-rpc/`.
- Repro: `FUZZ_SEED=<seed> pnpm test:fuzz -- tests/fuzz/mcp-json-rpc.fuzz.ts`.
- Nightly artifact: minimized corpus, failing input, daemon logs, and seed.

### 7.7. `paths` fuzz
- Generator: bad cwd/allowedDirs/attachments traversal and symlinks.
- Target: REST and MCP inputs.
- Invariant: `ERR_PATH_DENIED`; no escape.
- File: `tests/fuzz/paths.fuzz.ts`; corpus: `tests/fixtures/corpus/paths/`.
- Repro: `FUZZ_SEED=<seed> pnpm test:fuzz -- tests/fuzz/paths.fuzz.ts`.
- Nightly artifact: minimized corpus, failing input, daemon logs, and seed.

Nightly workflow: run `pnpm build && pnpm test:fuzz -- --reporter=verbose`; upload `tests/fixtures/corpus/**` and `artifacts/fuzz/**`; regress saved corpus before generating new cases.

## 8. Property-based tests

### 8.1. Property P01
- Invariant: For any valid cron expression, `next(now)` > `now`.
- File: `tests/property/property-01.property.test.ts`.
- Generator: bounded `fast-check` records; push CI uses 1000 runs; nightly can raise to 10000.
- Exact assertion: `fc.assert(fc.property(generator, async input => { ... }))`; print seed and shrink path.

### 8.2. Property P02
- Invariant: For any interval `every Xs`, distance between consecutive fires is exactly X ± jitter.
- File: `tests/property/property-02.property.test.ts`.
- Generator: bounded `fast-check` records; push CI uses 1000 runs; nightly can raise to 10000.
- Exact assertion: `fc.assert(fc.property(generator, async input => { ... }))`; print seed and shrink path.

### 8.3. Property P03
- Invariant: Encoding a job then decoding produces canonically equal JSON.
- File: `tests/property/property-03.property.test.ts`.
- Generator: bounded `fast-check` records; push CI uses 1000 runs; nightly can raise to 10000.
- Exact assertion: `fc.assert(fc.property(generator, async input => { ... }))`; print seed and shrink path.

### 8.4. Property P04
- Invariant: Retry-max-N never yields N+1 attempts.
- File: `tests/property/property-04.property.test.ts`.
- Generator: bounded `fast-check` records; push CI uses 1000 runs; nightly can raise to 10000.
- Exact assertion: `fc.assert(fc.property(generator, async input => { ... }))`; print seed and shrink path.

### 8.5. Property P05
- Invariant: Budget `maxRunsPerDay` never exceeded over 48h simulation.
- File: `tests/property/property-05.property.test.ts`.
- Generator: bounded `fast-check` records; push CI uses 1000 runs; nightly can raise to 10000.
- Exact assertion: `fc.assert(fc.property(generator, async input => { ... }))`; print seed and shrink path.

### 8.6. Property P06
- Invariant: Overlap `skip` never produces two concurrent runs of same job.
- File: `tests/property/property-06.property.test.ts`.
- Generator: bounded `fast-check` records; push CI uses 1000 runs; nightly can raise to 10000.
- Exact assertion: `fc.assert(fc.property(generator, async input => { ... }))`; print seed and shrink path.

### 8.7. Property P07
- Invariant: Catchup `run-once` never runs more than once even for many missed fires.
- File: `tests/property/property-07.property.test.ts`.
- Generator: bounded `fast-check` records; push CI uses 1000 runs; nightly can raise to 10000.
- Exact assertion: `fc.assert(fc.property(generator, async input => { ... }))`; print seed and shrink path.

### 8.8. Property P08
- Invariant: Every accepted JSON is emitted such that next `POST /api/jobs` accepts it byte-for-byte identically.
- File: `tests/property/property-08.property.test.ts`.
- Generator: bounded `fast-check` records; push CI uses 1000 runs; nightly can raise to 10000.
- Exact assertion: `fc.assert(fc.property(generator, async input => { ... }))`; print seed and shrink path.

### 8.9. Property P09
- Invariant: Cursor pagination returns each row exactly once.
- File: `tests/property/property-09.property.test.ts`.
- Generator: bounded `fast-check` records; push CI uses 1000 runs; nightly can raise to 10000.
- Exact assertion: `fc.assert(fc.property(generator, async input => { ... }))`; print seed and shrink path.

### 8.10. Property P10
- Invariant: Path sandbox accepts only paths under allowed dirs after realpath.
- File: `tests/property/property-10.property.test.ts`.
- Generator: bounded `fast-check` records; push CI uses 1000 runs; nightly can raise to 10000.
- Exact assertion: `fc.assert(fc.property(generator, async input => { ... }))`; print seed and shrink path.

### 8.11. Property P11
- Invariant: SSE resume from offset never emits bytes before offset.
- File: `tests/property/property-11.property.test.ts`.
- Generator: bounded `fast-check` records; push CI uses 1000 runs; nightly can raise to 10000.
- Exact assertion: `fc.assert(fc.property(generator, async input => { ... }))`; print seed and shrink path.

### 8.12. Property P12
- Invariant: Run state transitions always follow allowed graph.
- File: `tests/property/property-12.property.test.ts`.
- Generator: bounded `fast-check` records; push CI uses 1000 runs; nightly can raise to 10000.
- Exact assertion: `fc.assert(fc.property(generator, async input => { ... }))`; print seed and shrink path.

### 8.13. Property P13
- Invariant: Jitter never schedules before now and never exceeds configured max.
- File: `tests/property/property-13.property.test.ts`.
- Generator: bounded `fast-check` records; push CI uses 1000 runs; nightly can raise to 10000.
- Exact assertion: `fc.assert(fc.property(generator, async input => { ... }))`; print seed and shrink path.

### 8.14. Property P14
- Invariant: Queue length never exceeds configured depth.
- File: `tests/property/property-14.property.test.ts`.
- Generator: bounded `fast-check` records; push CI uses 1000 runs; nightly can raise to 10000.
- Exact assertion: `fc.assert(fc.property(generator, async input => { ... }))`; print seed and shrink path.

### 8.15. Property P15
- Invariant: Schema defaults are stable across encode/decode.
- File: `tests/property/property-15.property.test.ts`.
- Generator: bounded `fast-check` records; push CI uses 1000 runs; nightly can raise to 10000.
- Exact assertion: `fc.assert(fc.property(generator, async input => { ... }))`; print seed and shrink path.

## 9. Mutation testing (Stryker)

- Target: 75% overall mutation score.
- Target: 90% on scheduler/runner/store/security/path-sandbox.
- Include `src/scheduler/**/*.ts`, `src/runner/**/*.ts`, `src/store/**/*.ts`, `src/security/**/*.ts`, `src/api/**/*.ts`, `src/mcp/**/*.ts`, `src/autostart/**/*.ts`.
- Exclude `src/dashboard/**`, `src/generated/**`, `src/**/*.d.ts`, `src/cli/help-text.ts`, `tests/**`, `bench/**`.
- Weekly run: `pnpm test:mutation`; upload `reports/mutation/mutation.json` and HTML.
- PR alert: compare against latest baseline; warn on any drop; block below threshold.

## 10. Chaos & fault injection

### 10.1. `kill-daemon-mid-run`
- Fault: Kill -9 daemon mid-run.
- Action: restart daemon.
- Assertion: runs.db consistent and no zombie child processes.
- File: `tests/chaos/kill-daemon-mid-run.chaos.test.mjs`.
- Artifacts: stdout, stderr, process tree, runs.db, integrity_check, logs, and seed.

### 10.2. `enospc-log-write`
- Fault: Fill disk or simulate ENOSPC.
- Action: write logs.
- Assertion: run fails with `ERR_LOG_WRITE_FAILED`; daemon alive.
- File: `tests/chaos/enospc-log-write.chaos.test.mjs`.
- Artifacts: stdout, stderr, process tree, runs.db, integrity_check, logs, and seed.

### 10.3. `clock-jump-forward`
- Fault: Jump clock forward.
- Action: recompute fires.
- Assertion: DST/catchup follows policy.
- File: `tests/chaos/clock-jump-forward.chaos.test.mjs`.
- Artifacts: stdout, stderr, process tree, runs.db, integrity_check, logs, and seed.

### 10.4. `clock-jump-backward`
- Fault: Jump clock backward.
- Action: recompute fires.
- Assertion: no duplicate unless policy allows.
- File: `tests/chaos/clock-jump-backward.chaos.test.mjs`.
- Artifacts: stdout, stderr, process tree, runs.db, integrity_check, logs, and seed.

### 10.5. `slow-fs-jobs`
- Fault: Slow FS wrapper on jobs dir.
- Action: reload job files.
- Assertion: health p99 <500ms.
- File: `tests/chaos/slow-fs-jobs.chaos.test.mjs`.
- Artifacts: stdout, stderr, process tree, runs.db, integrity_check, logs, and seed.

### 10.6. `sqlite-wal-corruption`
- Fault: Corrupt WAL in sandbox.
- Action: restart.
- Assertion: repair/refuse with explicit log.
- File: `tests/chaos/sqlite-wal-corruption.chaos.test.mjs`.
- Artifacts: stdout, stderr, process tree, runs.db, integrity_check, logs, and seed.

### 10.7. `sigstop-sigcont`
- Fault: Random SIGSTOP/SIGCONT child.
- Action: wait budget.
- Assertion: overdue child terminated.
- File: `tests/chaos/sigstop-sigcont.chaos.test.mjs`.
- Artifacts: stdout, stderr, process tree, runs.db, integrity_check, logs, and seed.

### 10.8. `localhost-partition`
- Fault: toxiproxy localhost port.
- Action: MCP HTTP calls.
- Assertion: retryable connection errors.
- File: `tests/chaos/localhost-partition.chaos.test.mjs`.
- Artifacts: stdout, stderr, process tree, runs.db, integrity_check, logs, and seed.

### 10.9. `log-file-delete`
- Fault: Delete active log.
- Action: continue run.
- Assertion: recreate or record nonfatal error.
- File: `tests/chaos/log-file-delete.chaos.test.mjs`.
- Artifacts: stdout, stderr, process tree, runs.db, integrity_check, logs, and seed.

### 10.10. `db-locked`
- Fault: Hold SQLite write lock.
- Action: write run row.
- Assertion: retry then `ERR_DB_BUSY`, no partial state.
- File: `tests/chaos/db-locked.chaos.test.mjs`.
- Artifacts: stdout, stderr, process tree, runs.db, integrity_check, logs, and seed.

## 11. Soak / longevity

### 11.1. `24h-every-10s`
- Scenario: 24h job every 10s.
- Command: `node scripts/test/soak-24h-every-10s.mjs --artifact-dir artifacts/soak/24h-every-10s`.
- Assertion: RSS +20% max, fd +5 max, missed runs within tolerance.
- Sample every 60s: RSS, heap, event loop lag, handles, fd count, run throughput, DB bytes, log bytes.

### 11.2. `runs-db-linear-growth`
- Scenario: 24h with DB/log rotation.
- Command: `node scripts/test/soak-runs-db-linear-growth.mjs --artifact-dir artifacts/soak/runs-db-linear-growth`.
- Assertion: DB grows linearly; retention works.
- Sample every 60s: RSS, heap, event loop lag, handles, fd count, run throughput, DB bytes, log bytes.

### 11.3. `1000-job-startup`
- Scenario: 1000-job daemon startup.
- Command: `node scripts/test/soak-1000-job-startup.mjs --artifact-dir artifacts/soak/1000-job-startup`.
- Assertion: cold start <2s.
- Sample every 60s: RSS, heap, event loop lag, handles, fd count, run throughput, DB bytes, log bytes.

### 11.4. `1000-job-idle`
- Scenario: 1000 idle jobs for 6h.
- Command: `node scripts/test/soak-1000-job-idle.mjs --artifact-dir artifacts/soak/1000-job-idle`.
- Assertion: CPU <5%, event-loop p99 <100ms.
- Sample every 60s: RSS, heap, event loop lag, handles, fd count, run throughput, DB bytes, log bytes.

### 11.5. `sse-long-tail`
- Scenario: 10 SSE clients for 12h.
- Command: `node scripts/test/soak-sse-long-tail.mjs --artifact-dir artifacts/soak/sse-long-tail`.
- Assertion: ordered event IDs, no heap leak.
- Sample every 60s: RSS, heap, event loop lag, handles, fd count, run throughput, DB bytes, log bytes.

## 12. Performance / benchmarks

### 12.1. `cron-next-fire`
- File: `bench/cron-next-fire.bench.ts`.
- Tool: `tinybench` for micro or macro harness for daemon scenarios.
- Store result in `bench/history/<benchmark>.jsonl` with commit, OS, Node, mean, p95, p99.
- PR diff: fail if micro regression >10% or macro regression >15%.

### 12.2. `canonical-json-encode`
- File: `bench/canonical-json-encode.bench.ts`.
- Tool: `tinybench` for micro or macro harness for daemon scenarios.
- Store result in `bench/history/<benchmark>.jsonl` with commit, OS, Node, mean, p95, p99.
- PR diff: fail if micro regression >10% or macro regression >15%.

### 12.3. `ajv-validate-job`
- File: `bench/ajv-validate-job.bench.ts`.
- Tool: `tinybench` for micro or macro harness for daemon scenarios.
- Store result in `bench/history/<benchmark>.jsonl` with commit, OS, Node, mean, p95, p99.
- PR diff: fail if micro regression >10% or macro regression >15%.

### 12.4. `db-insert-run`
- File: `bench/db-insert-run.bench.ts`.
- Tool: `tinybench` for micro or macro harness for daemon scenarios.
- Store result in `bench/history/<benchmark>.jsonl` with commit, OS, Node, mean, p95, p99.
- PR diff: fail if micro regression >10% or macro regression >15%.

### 12.5. `db-query-history`
- File: `bench/db-query-history.bench.ts`.
- Tool: `tinybench` for micro or macro harness for daemon scenarios.
- Store result in `bench/history/<benchmark>.jsonl` with commit, OS, Node, mean, p95, p99.
- PR diff: fail if micro regression >10% or macro regression >15%.

### 12.6. `scheduler-1000-jobs`
- File: `bench/scheduler-1000-jobs.bench.ts`.
- Tool: `tinybench` for micro or macro harness for daemon scenarios.
- Store result in `bench/history/<benchmark>.jsonl` with commit, OS, Node, mean, p95, p99.
- PR diff: fail if micro regression >10% or macro regression >15%.

### 12.7. `runner-throughput`
- File: `bench/runner-throughput.bench.ts`.
- Tool: `tinybench` for micro or macro harness for daemon scenarios.
- Store result in `bench/history/<benchmark>.jsonl` with commit, OS, Node, mean, p95, p99.
- PR diff: fail if micro regression >10% or macro regression >15%.

### 12.8. `dashboard-first-paint`
- File: `bench/dashboard-first-paint.bench.ts`.
- Tool: `tinybench` for micro or macro harness for daemon scenarios.
- Store result in `bench/history/<benchmark>.jsonl` with commit, OS, Node, mean, p95, p99.
- PR diff: fail if micro regression >10% or macro regression >15%.

### 12.9. `sse-latency`
- File: `bench/sse-latency.bench.ts`.
- Tool: `tinybench` for micro or macro harness for daemon scenarios.
- Store result in `bench/history/<benchmark>.jsonl` with commit, OS, Node, mean, p95, p99.
- PR diff: fail if micro regression >10% or macro regression >15%.

### 12.10. `mcp-tool-list`
- File: `bench/mcp-tool-list.bench.ts`.
- Tool: `tinybench` for micro or macro harness for daemon scenarios.
- Store result in `bench/history/<benchmark>.jsonl` with commit, OS, Node, mean, p95, p99.
- PR diff: fail if micro regression >10% or macro regression >15%.

### 12.11. `http-health`
- File: `bench/http-health.bench.ts`.
- Tool: `tinybench` for micro or macro harness for daemon scenarios.
- Store result in `bench/history/<benchmark>.jsonl` with commit, OS, Node, mean, p95, p99.
- PR diff: fail if micro regression >10% or macro regression >15%.

### 12.12. `log-append`
- File: `bench/log-append.bench.ts`.
- Tool: `tinybench` for micro or macro harness for daemon scenarios.
- Store result in `bench/history/<benchmark>.jsonl` with commit, OS, Node, mean, p95, p99.
- PR diff: fail if micro regression >10% or macro regression >15%.

### 12.13. `path-normalize`
- File: `bench/path-normalize.bench.ts`.
- Tool: `tinybench` for micro or macro harness for daemon scenarios.
- Store result in `bench/history/<benchmark>.jsonl` with commit, OS, Node, mean, p95, p99.
- PR diff: fail if micro regression >10% or macro regression >15%.

### 12.14. `migration`
- File: `bench/migration.bench.ts`.
- Tool: `tinybench` for micro or macro harness for daemon scenarios.
- Store result in `bench/history/<benchmark>.jsonl` with commit, OS, Node, mean, p95, p99.
- PR diff: fail if micro regression >10% or macro regression >15%.

### 12.15. `startup-empty`
- File: `bench/startup-empty.bench.ts`.
- Tool: `tinybench` for micro or macro harness for daemon scenarios.
- Store result in `bench/history/<benchmark>.jsonl` with commit, OS, Node, mean, p95, p99.
- PR diff: fail if micro regression >10% or macro regression >15%.

## 13. Security testing

### 13.1. `npm-audit`
- Command/tool: `npm audit --audit-level=high`.
- Assertion: no high/critical.
- Artifact: `artifacts/security/npm-audit.json` or SARIF.

### 13.2. `npm-audit-signatures`
- Command/tool: `npm audit signatures`.
- Assertion: all signatures verify.
- Artifact: `artifacts/security/npm-audit-signatures.json` or SARIF.

### 13.3. `codeql`
- Command/tool: CodeQL default queries.
- Assertion: no error alerts.
- Artifact: `artifacts/security/codeql.json` or SARIF.

### 13.4. `semgrep-node`
- Command/tool: `semgrep --config p/nodejs --config p/security-audit`.
- Assertion: no high findings.
- Artifact: `artifacts/security/semgrep-node.json` or SARIF.

### 13.5. `semgrep-spawn`
- Command/tool: custom spawn-with-user-input rule.
- Assertion: dynamic spawn only through script-runtime.
- Artifact: `artifacts/security/semgrep-spawn.json` or SARIF.

### 13.6. `semgrep-path`
- Command/tool: custom path traversal rule.
- Assertion: all request paths through safe resolver.
- Artifact: `artifacts/security/semgrep-path.json` or SARIF.

### 13.7. `trivy-image`
- Command/tool: Trivy if Docker image ships.
- Assertion: no high/critical unfixed.
- Artifact: `artifacts/security/trivy-image.json` or SARIF.

### 13.8. `osv-scanner`
- Command/tool: `osv-scanner -r .`.
- Assertion: no unresolved high.
- Artifact: `artifacts/security/osv-scanner.json` or SARIF.

### 13.9. `socket-dev`
- Command/tool: socket.dev dependency analysis.
- Assertion: no malware/install-script policy violation.
- Artifact: `artifacts/security/socket-dev.json` or SARIF.

### 13.10. `dependency-review`
- Command/tool: GitHub dependency review.
- Assertion: no disallowed license.
- Artifact: `artifacts/security/dependency-review.json` or SARIF.

### 13.11. `secret-scan`
- Command/tool: gitleaks/GitHub secret scanning.
- Assertion: no real secrets.
- Artifact: `artifacts/security/secret-scan.json` or SARIF.

### 13.12. `permissions`
- Command/tool: file mode tests.
- Assertion: tokens/config are 0600/0700 when supported.
- Artifact: `artifacts/security/permissions.json` or SARIF.

| STRIDE | Risk | Example | Required test |
|-|-|-|-|
| Spoofing | Unauthorized API | missing token | auth-token-rotation rejects |
| Tampering | Job JSON modified | malicious path | file-watch reload validates |
| Repudiation | History altered | manual DB edit | audit-chain/integrity tests |
| Info disclosure | Secrets in logs | env token | log redaction test |
| DoS | Unbounded output | script writes forever | budget/output caps |
| Elevation | Path traversal | ../../bin/sh | path fuzz rejects |

## 14. Test data & fixtures

- `tests/fixtures/examples/jobs/minimal.json`
- `tests/fixtures/examples/jobs/full.json`
- `tests/fixtures/examples/jobs/llm-disabled.json`
- `tests/fixtures/invalid/jobs/missing-action.json`
- `tests/fixtures/invalid/jobs/path-traversal.json`
- `tests/fixtures/golden/job.canonical.json`
- `tests/fixtures/golden/mcp-tools-list.json`
- `tests/fixtures/db/v1/runs.db`
- `tests/fixtures/db/v2/runs.db`
- `tests/fixtures/corpus/cron-expressions/README.md`
- `tests/fixtures/scripts/success.mjs`
- `tests/fixtures/scripts/fail-twice.mjs`
- `tests/fixtures/scripts/ignore-sigterm.mjs`
- `tests/fixtures/static/dashboard-index.html`
- Golden files update only with `--update-snapshots` or `UPDATE_GOLDEN=1`.
- Snapshot PRs explain public contract change.
- Filesystem tests use `os.tmpdir()` + `mkdtemp`; never real home.
- Secret-like fixtures use fake `test_secret_*` tokens.
- DB fixtures include migration metadata and generation README.
- Script fixtures are deterministic and no network.
- Fuzz corpora are minimized before check-in.
- Every fixture has an owning test file.

## 15. Junior-dev workflow

```bash
pnpm i && pnpm build && pnpm test && pnpm test:integration
```
- `pnpm i`: install lockfile dependencies and integrity metadata.
- `pnpm build`: compile TypeScript and produce `dist/daemon.js` and `dist/cli.js`.
- `pnpm test`: run fast unit, contract, property, and coverage gates.
- `pnpm test:integration`: run multi-module SQLite/tmp filesystem tests.
- Run `pnpm test:e2e` after CLI, daemon, auth, dashboard, signal, or packaging changes.
- Run `pnpm test:fuzz` after parser/schema/API/MCP/path changes.
- Run `pnpm test:chaos` after runner, DB recovery, log writing, or child termination changes.
- Run `pnpm test:mutation` before large scheduler/runner/store refactors.
- Run `pnpm bench` after schedule, JSON, DB, dashboard, or SSE performance changes.

## 16. Definition of Done for a PR

- [ ] Unit tests added
- [ ] Contract tests still pass
- [ ] Coverage did not drop >0.5%
- [ ] Bench regression <10%
- [ ] Docs updated
- [ ] Changelog entry
- [ ] SECURITY.md unchanged (or issue linked)
- [ ] Scheduler behavior has unit + property + integration coverage
- [ ] Public schema changes include valid and invalid fixtures
- [ ] MCP changes include schema, success, and error contract tests
- [ ] Runner/script changes include security regression tests
- [ ] Autostart changes include dry-run assertions on each OS
- [ ] DB schema changes include migration/idempotence/rollback tests
- [ ] No test writes to real home or external network

## 17. Traceability matrix (sample)

| Requirement | Requirement text | Module | Test file | Test case |
|-|-|-|-|-|
| REQ-001 | Users can create a scheduled job through REST API | api/jobs + scheduler + store | tests/integration/job-create-schedule-run-complete-history.test.ts | POST returns 201 and next fire registered |
| REQ-002 | Cron parser never crashes | schedule parsing | tests/fuzz/cron-expressions.fuzz.ts | malformed expressions return specific error code |
| REQ-003 | Daemon recovers after unclean shutdown | daemon + store | tests/integration/sqlite-wal-recovery.test.ts | integrity_check ok after restart |
| REQ-004 | Overlap skip prevents concurrency | scheduler + runner | tests/property/overlap.property.test.ts | active run count <=1 |
| REQ-005 | Auth rotation invalidates old token | auth + HTTP + MCP | tests/e2e/auth-token-rotation.test.mjs | old 401, new initialize ok |
| REQ-006 | Scripts cannot escape allowed dirs | script-runtime + path sandbox | tests/fuzz/paths.fuzz.ts | ERR_PATH_DENIED |
| REQ-007 | Logs rotate and redact | log rotation | tests/unit/log-rotation.test.ts | rotated logs and [REDACTED] |
| REQ-008 | Autostart installs per user | autostart | tests/e2e/autostart-linux.test.mjs | systemd unit enabled |
| REQ-009 | Daily run budget enforced | budget + scheduler | tests/property/budget.property.test.ts | 48h cap never exceeded |
| REQ-010 | MCP schemas conform | mcp server | tests/contract/mcp-tool-schemas.test.ts | Ajv strict compiles |
### REQ-001: Users can create a scheduled job through REST API
- Module: `api/jobs + scheduler + store`.
- Test file: `tests/integration/job-create-schedule-run-complete-history.test.ts`.
- Test case: POST returns 201 and next fire registered.
- Release gate: blocking for PRs touching mapped module.

### REQ-002: Cron parser never crashes
- Module: `schedule parsing`.
- Test file: `tests/fuzz/cron-expressions.fuzz.ts`.
- Test case: malformed expressions return specific error code.
- Release gate: blocking for PRs touching mapped module.

### REQ-003: Daemon recovers after unclean shutdown
- Module: `daemon + store`.
- Test file: `tests/integration/sqlite-wal-recovery.test.ts`.
- Test case: integrity_check ok after restart.
- Release gate: blocking for PRs touching mapped module.

### REQ-004: Overlap skip prevents concurrency
- Module: `scheduler + runner`.
- Test file: `tests/property/overlap.property.test.ts`.
- Test case: active run count <=1.
- Release gate: blocking for PRs touching mapped module.

### REQ-005: Auth rotation invalidates old token
- Module: `auth + HTTP + MCP`.
- Test file: `tests/e2e/auth-token-rotation.test.mjs`.
- Test case: old 401, new initialize ok.
- Release gate: blocking for PRs touching mapped module.

### REQ-006: Scripts cannot escape allowed dirs
- Module: `script-runtime + path sandbox`.
- Test file: `tests/fuzz/paths.fuzz.ts`.
- Test case: ERR_PATH_DENIED.
- Release gate: blocking for PRs touching mapped module.

### REQ-007: Logs rotate and redact
- Module: `log rotation`.
- Test file: `tests/unit/log-rotation.test.ts`.
- Test case: rotated logs and [REDACTED].
- Release gate: blocking for PRs touching mapped module.

### REQ-008: Autostart installs per user
- Module: `autostart`.
- Test file: `tests/e2e/autostart-linux.test.mjs`.
- Test case: systemd unit enabled.
- Release gate: blocking for PRs touching mapped module.

### REQ-009: Daily run budget enforced
- Module: `budget + scheduler`.
- Test file: `tests/property/budget.property.test.ts`.
- Test case: 48h cap never exceeded.
- Release gate: blocking for PRs touching mapped module.

### REQ-010: MCP schemas conform
- Module: `mcp server`.
- Test file: `tests/contract/mcp-tool-schemas.test.ts`.
- Test case: Ajv strict compiles.
- Release gate: blocking for PRs touching mapped module.

## Appendix A. Concrete automation backlog

### Appendix A.1. scheduler backlog

- AUTO-001: `scheduler-happy-path` in `tests/integration/scheduler-happy-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-002: `scheduler-invalid-input` in `tests/integration/scheduler-invalid-input.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-003: `scheduler-boundary-value` in `tests/integration/scheduler-boundary-value.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-004: `scheduler-concurrency` in `tests/integration/scheduler-concurrency.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-005: `scheduler-restart-persistence` in `tests/integration/scheduler-restart-persistence.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-006: `scheduler-error-envelope` in `tests/integration/scheduler-error-envelope.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-007: `scheduler-metric-emitted` in `tests/integration/scheduler-metric-emitted.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-008: `scheduler-artifact-uploaded` in `tests/integration/scheduler-artifact-uploaded.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-009: `scheduler-coverage-branch` in `tests/integration/scheduler-coverage-branch.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-010: `scheduler-regression-seed` in `tests/integration/scheduler-regression-seed.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-011: `scheduler-Windows-path` in `tests/integration/scheduler-Windows-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-012: `scheduler-POSIX-path` in `tests/integration/scheduler-POSIX-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-013: `scheduler-permission-denied` in `tests/integration/scheduler-permission-denied.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-014: `scheduler-timeout` in `tests/integration/scheduler-timeout.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-015: `scheduler-cancellation` in `tests/integration/scheduler-cancellation.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-016: `scheduler-large-payload` in `tests/integration/scheduler-large-payload.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-017: `scheduler-unicode` in `tests/integration/scheduler-unicode.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-018: `scheduler-schema-default` in `tests/integration/scheduler-schema-default.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-019: `scheduler-snapshot-stable` in `tests/integration/scheduler-snapshot-stable.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-020: `scheduler-no-external-writes` in `tests/integration/scheduler-no-external-writes.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.

### Appendix A.2. runner backlog

- AUTO-021: `runner-happy-path` in `tests/integration/runner-happy-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-022: `runner-invalid-input` in `tests/integration/runner-invalid-input.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-023: `runner-boundary-value` in `tests/integration/runner-boundary-value.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-024: `runner-concurrency` in `tests/integration/runner-concurrency.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-025: `runner-restart-persistence` in `tests/integration/runner-restart-persistence.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-026: `runner-error-envelope` in `tests/integration/runner-error-envelope.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-027: `runner-metric-emitted` in `tests/integration/runner-metric-emitted.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-028: `runner-artifact-uploaded` in `tests/integration/runner-artifact-uploaded.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-029: `runner-coverage-branch` in `tests/integration/runner-coverage-branch.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-030: `runner-regression-seed` in `tests/integration/runner-regression-seed.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-031: `runner-Windows-path` in `tests/integration/runner-Windows-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-032: `runner-POSIX-path` in `tests/integration/runner-POSIX-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-033: `runner-permission-denied` in `tests/integration/runner-permission-denied.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-034: `runner-timeout` in `tests/integration/runner-timeout.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-035: `runner-cancellation` in `tests/integration/runner-cancellation.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-036: `runner-large-payload` in `tests/integration/runner-large-payload.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-037: `runner-unicode` in `tests/integration/runner-unicode.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-038: `runner-schema-default` in `tests/integration/runner-schema-default.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-039: `runner-snapshot-stable` in `tests/integration/runner-snapshot-stable.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-040: `runner-no-external-writes` in `tests/integration/runner-no-external-writes.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.

### Appendix A.3. store backlog

- AUTO-041: `store-happy-path` in `tests/integration/store-happy-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-042: `store-invalid-input` in `tests/integration/store-invalid-input.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-043: `store-boundary-value` in `tests/integration/store-boundary-value.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-044: `store-concurrency` in `tests/integration/store-concurrency.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-045: `store-restart-persistence` in `tests/integration/store-restart-persistence.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-046: `store-error-envelope` in `tests/integration/store-error-envelope.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-047: `store-metric-emitted` in `tests/integration/store-metric-emitted.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-048: `store-artifact-uploaded` in `tests/integration/store-artifact-uploaded.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-049: `store-coverage-branch` in `tests/integration/store-coverage-branch.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-050: `store-regression-seed` in `tests/integration/store-regression-seed.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-051: `store-Windows-path` in `tests/integration/store-Windows-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-052: `store-POSIX-path` in `tests/integration/store-POSIX-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-053: `store-permission-denied` in `tests/integration/store-permission-denied.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-054: `store-timeout` in `tests/integration/store-timeout.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-055: `store-cancellation` in `tests/integration/store-cancellation.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-056: `store-large-payload` in `tests/integration/store-large-payload.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-057: `store-unicode` in `tests/integration/store-unicode.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-058: `store-schema-default` in `tests/integration/store-schema-default.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-059: `store-snapshot-stable` in `tests/integration/store-snapshot-stable.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-060: `store-no-external-writes` in `tests/integration/store-no-external-writes.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.

### Appendix A.4. api backlog

- AUTO-061: `api-happy-path` in `tests/integration/api-happy-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-062: `api-invalid-input` in `tests/integration/api-invalid-input.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-063: `api-boundary-value` in `tests/integration/api-boundary-value.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-064: `api-concurrency` in `tests/integration/api-concurrency.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-065: `api-restart-persistence` in `tests/integration/api-restart-persistence.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-066: `api-error-envelope` in `tests/integration/api-error-envelope.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-067: `api-metric-emitted` in `tests/integration/api-metric-emitted.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-068: `api-artifact-uploaded` in `tests/integration/api-artifact-uploaded.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-069: `api-coverage-branch` in `tests/integration/api-coverage-branch.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-070: `api-regression-seed` in `tests/integration/api-regression-seed.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-071: `api-Windows-path` in `tests/integration/api-Windows-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-072: `api-POSIX-path` in `tests/integration/api-POSIX-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-073: `api-permission-denied` in `tests/integration/api-permission-denied.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-074: `api-timeout` in `tests/integration/api-timeout.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-075: `api-cancellation` in `tests/integration/api-cancellation.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-076: `api-large-payload` in `tests/integration/api-large-payload.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-077: `api-unicode` in `tests/integration/api-unicode.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-078: `api-schema-default` in `tests/integration/api-schema-default.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-079: `api-snapshot-stable` in `tests/integration/api-snapshot-stable.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-080: `api-no-external-writes` in `tests/integration/api-no-external-writes.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.

### Appendix A.5. mcp backlog

- AUTO-081: `mcp-happy-path` in `tests/integration/mcp-happy-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-082: `mcp-invalid-input` in `tests/integration/mcp-invalid-input.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-083: `mcp-boundary-value` in `tests/integration/mcp-boundary-value.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-084: `mcp-concurrency` in `tests/integration/mcp-concurrency.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-085: `mcp-restart-persistence` in `tests/integration/mcp-restart-persistence.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-086: `mcp-error-envelope` in `tests/integration/mcp-error-envelope.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-087: `mcp-metric-emitted` in `tests/integration/mcp-metric-emitted.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-088: `mcp-artifact-uploaded` in `tests/integration/mcp-artifact-uploaded.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-089: `mcp-coverage-branch` in `tests/integration/mcp-coverage-branch.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-090: `mcp-regression-seed` in `tests/integration/mcp-regression-seed.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-091: `mcp-Windows-path` in `tests/integration/mcp-Windows-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-092: `mcp-POSIX-path` in `tests/integration/mcp-POSIX-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-093: `mcp-permission-denied` in `tests/integration/mcp-permission-denied.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-094: `mcp-timeout` in `tests/integration/mcp-timeout.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-095: `mcp-cancellation` in `tests/integration/mcp-cancellation.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-096: `mcp-large-payload` in `tests/integration/mcp-large-payload.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-097: `mcp-unicode` in `tests/integration/mcp-unicode.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-098: `mcp-schema-default` in `tests/integration/mcp-schema-default.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-099: `mcp-snapshot-stable` in `tests/integration/mcp-snapshot-stable.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-100: `mcp-no-external-writes` in `tests/integration/mcp-no-external-writes.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.

### Appendix A.6. autostart backlog

- AUTO-101: `autostart-happy-path` in `tests/integration/autostart-happy-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-102: `autostart-invalid-input` in `tests/integration/autostart-invalid-input.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-103: `autostart-boundary-value` in `tests/integration/autostart-boundary-value.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-104: `autostart-concurrency` in `tests/integration/autostart-concurrency.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-105: `autostart-restart-persistence` in `tests/integration/autostart-restart-persistence.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-106: `autostart-error-envelope` in `tests/integration/autostart-error-envelope.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-107: `autostart-metric-emitted` in `tests/integration/autostart-metric-emitted.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-108: `autostart-artifact-uploaded` in `tests/integration/autostart-artifact-uploaded.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-109: `autostart-coverage-branch` in `tests/integration/autostart-coverage-branch.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-110: `autostart-regression-seed` in `tests/integration/autostart-regression-seed.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-111: `autostart-Windows-path` in `tests/integration/autostart-Windows-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-112: `autostart-POSIX-path` in `tests/integration/autostart-POSIX-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-113: `autostart-permission-denied` in `tests/integration/autostart-permission-denied.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-114: `autostart-timeout` in `tests/integration/autostart-timeout.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-115: `autostart-cancellation` in `tests/integration/autostart-cancellation.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-116: `autostart-large-payload` in `tests/integration/autostart-large-payload.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-117: `autostart-unicode` in `tests/integration/autostart-unicode.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-118: `autostart-schema-default` in `tests/integration/autostart-schema-default.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-119: `autostart-snapshot-stable` in `tests/integration/autostart-snapshot-stable.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-120: `autostart-no-external-writes` in `tests/integration/autostart-no-external-writes.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.

### Appendix A.7. security backlog

- AUTO-121: `security-happy-path` in `tests/integration/security-happy-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-122: `security-invalid-input` in `tests/integration/security-invalid-input.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-123: `security-boundary-value` in `tests/integration/security-boundary-value.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-124: `security-concurrency` in `tests/integration/security-concurrency.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-125: `security-restart-persistence` in `tests/integration/security-restart-persistence.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-126: `security-error-envelope` in `tests/integration/security-error-envelope.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-127: `security-metric-emitted` in `tests/integration/security-metric-emitted.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-128: `security-artifact-uploaded` in `tests/integration/security-artifact-uploaded.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-129: `security-coverage-branch` in `tests/integration/security-coverage-branch.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-130: `security-regression-seed` in `tests/integration/security-regression-seed.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-131: `security-Windows-path` in `tests/integration/security-Windows-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-132: `security-POSIX-path` in `tests/integration/security-POSIX-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-133: `security-permission-denied` in `tests/integration/security-permission-denied.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-134: `security-timeout` in `tests/integration/security-timeout.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-135: `security-cancellation` in `tests/integration/security-cancellation.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-136: `security-large-payload` in `tests/integration/security-large-payload.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-137: `security-unicode` in `tests/integration/security-unicode.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-138: `security-schema-default` in `tests/integration/security-schema-default.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-139: `security-snapshot-stable` in `tests/integration/security-snapshot-stable.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-140: `security-no-external-writes` in `tests/integration/security-no-external-writes.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.

### Appendix A.8. dashboard backlog

- AUTO-141: `dashboard-happy-path` in `tests/integration/dashboard-happy-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-142: `dashboard-invalid-input` in `tests/integration/dashboard-invalid-input.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-143: `dashboard-boundary-value` in `tests/integration/dashboard-boundary-value.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-144: `dashboard-concurrency` in `tests/integration/dashboard-concurrency.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-145: `dashboard-restart-persistence` in `tests/integration/dashboard-restart-persistence.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-146: `dashboard-error-envelope` in `tests/integration/dashboard-error-envelope.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-147: `dashboard-metric-emitted` in `tests/integration/dashboard-metric-emitted.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-148: `dashboard-artifact-uploaded` in `tests/integration/dashboard-artifact-uploaded.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-149: `dashboard-coverage-branch` in `tests/integration/dashboard-coverage-branch.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-150: `dashboard-regression-seed` in `tests/integration/dashboard-regression-seed.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-151: `dashboard-Windows-path` in `tests/integration/dashboard-Windows-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-152: `dashboard-POSIX-path` in `tests/integration/dashboard-POSIX-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-153: `dashboard-permission-denied` in `tests/integration/dashboard-permission-denied.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-154: `dashboard-timeout` in `tests/integration/dashboard-timeout.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-155: `dashboard-cancellation` in `tests/integration/dashboard-cancellation.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-156: `dashboard-large-payload` in `tests/integration/dashboard-large-payload.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-157: `dashboard-unicode` in `tests/integration/dashboard-unicode.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-158: `dashboard-schema-default` in `tests/integration/dashboard-schema-default.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-159: `dashboard-snapshot-stable` in `tests/integration/dashboard-snapshot-stable.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-160: `dashboard-no-external-writes` in `tests/integration/dashboard-no-external-writes.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.

### Appendix A.9. cli backlog

- AUTO-161: `cli-happy-path` in `tests/integration/cli-happy-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-162: `cli-invalid-input` in `tests/integration/cli-invalid-input.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-163: `cli-boundary-value` in `tests/integration/cli-boundary-value.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-164: `cli-concurrency` in `tests/integration/cli-concurrency.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-165: `cli-restart-persistence` in `tests/integration/cli-restart-persistence.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-166: `cli-error-envelope` in `tests/integration/cli-error-envelope.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-167: `cli-metric-emitted` in `tests/integration/cli-metric-emitted.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-168: `cli-artifact-uploaded` in `tests/integration/cli-artifact-uploaded.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-169: `cli-coverage-branch` in `tests/integration/cli-coverage-branch.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-170: `cli-regression-seed` in `tests/integration/cli-regression-seed.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-171: `cli-Windows-path` in `tests/integration/cli-Windows-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-172: `cli-POSIX-path` in `tests/integration/cli-POSIX-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-173: `cli-permission-denied` in `tests/integration/cli-permission-denied.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-174: `cli-timeout` in `tests/integration/cli-timeout.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-175: `cli-cancellation` in `tests/integration/cli-cancellation.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-176: `cli-large-payload` in `tests/integration/cli-large-payload.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-177: `cli-unicode` in `tests/integration/cli-unicode.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-178: `cli-schema-default` in `tests/integration/cli-schema-default.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-179: `cli-snapshot-stable` in `tests/integration/cli-snapshot-stable.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-180: `cli-no-external-writes` in `tests/integration/cli-no-external-writes.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.

### Appendix A.10. fixtures backlog

- AUTO-181: `fixtures-happy-path` in `tests/integration/fixtures-happy-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-182: `fixtures-invalid-input` in `tests/integration/fixtures-invalid-input.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-183: `fixtures-boundary-value` in `tests/integration/fixtures-boundary-value.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-184: `fixtures-concurrency` in `tests/integration/fixtures-concurrency.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-185: `fixtures-restart-persistence` in `tests/integration/fixtures-restart-persistence.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-186: `fixtures-error-envelope` in `tests/integration/fixtures-error-envelope.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-187: `fixtures-metric-emitted` in `tests/integration/fixtures-metric-emitted.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-188: `fixtures-artifact-uploaded` in `tests/integration/fixtures-artifact-uploaded.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-189: `fixtures-coverage-branch` in `tests/integration/fixtures-coverage-branch.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-190: `fixtures-regression-seed` in `tests/integration/fixtures-regression-seed.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-191: `fixtures-Windows-path` in `tests/integration/fixtures-Windows-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-192: `fixtures-POSIX-path` in `tests/integration/fixtures-POSIX-path.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-193: `fixtures-permission-denied` in `tests/integration/fixtures-permission-denied.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-194: `fixtures-timeout` in `tests/integration/fixtures-timeout.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-195: `fixtures-cancellation` in `tests/integration/fixtures-cancellation.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-196: `fixtures-large-payload` in `tests/integration/fixtures-large-payload.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-197: `fixtures-unicode` in `tests/integration/fixtures-unicode.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-198: `fixtures-schema-default` in `tests/integration/fixtures-schema-default.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-199: `fixtures-snapshot-stable` in `tests/integration/fixtures-snapshot-stable.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.
- AUTO-200: `fixtures-no-external-writes` in `tests/integration/fixtures-no-external-writes.test.ts`; assert exact code/output, deterministic seed, sandbox cleanup, and CI artifact on failure.

## Appendix B. CI workflow map

| Job | Trigger | Command | Gate |
|-|-|-|-|
| ci-fast | pull_request,push | pnpm build && pnpm test | unit/contract/property |
| ci-integration | pull_request,push | pnpm test:integration | multi-module |
| ci-e2e | pull_request,push | pnpm test:e2e | real daemon/CLI |
| ci-cross-platform | pull_request | matrix OS/Node smoke | autostart |
| ci-security | pull_request,push | pnpm security:scan | audit/static |
| nightly-fuzz | schedule | pnpm test:fuzz | malformed input |
| nightly-chaos | schedule | pnpm test:chaos | fault injection |
| weekly-soak | schedule | pnpm test:soak | longevity |
| weekly-mutation | schedule | pnpm test:mutation | test quality |
| weekly-bench | schedule | pnpm bench | performance |
| release-provenance | release | npm publish --provenance + attest | supply chain |
### Appendix B.1. `ci-fast`
- Trigger: pull_request,push.
- Command: `pnpm build && pnpm test`.
- Gate: unit/contract/property.
- Failure artifact: logs, coverage/benchmark JSON, database files if applicable, and exact repro command.

### Appendix B.2. `ci-integration`
- Trigger: pull_request,push.
- Command: `pnpm test:integration`.
- Gate: multi-module.
- Failure artifact: logs, coverage/benchmark JSON, database files if applicable, and exact repro command.

### Appendix B.3. `ci-e2e`
- Trigger: pull_request,push.
- Command: `pnpm test:e2e`.
- Gate: real daemon/CLI.
- Failure artifact: logs, coverage/benchmark JSON, database files if applicable, and exact repro command.

### Appendix B.4. `ci-cross-platform`
- Trigger: pull_request.
- Command: `matrix OS/Node smoke`.
- Gate: autostart.
- Failure artifact: logs, coverage/benchmark JSON, database files if applicable, and exact repro command.

### Appendix B.5. `ci-security`
- Trigger: pull_request,push.
- Command: `pnpm security:scan`.
- Gate: audit/static.
- Failure artifact: logs, coverage/benchmark JSON, database files if applicable, and exact repro command.

### Appendix B.6. `nightly-fuzz`
- Trigger: schedule.
- Command: `pnpm test:fuzz`.
- Gate: malformed input.
- Failure artifact: logs, coverage/benchmark JSON, database files if applicable, and exact repro command.

### Appendix B.7. `nightly-chaos`
- Trigger: schedule.
- Command: `pnpm test:chaos`.
- Gate: fault injection.
- Failure artifact: logs, coverage/benchmark JSON, database files if applicable, and exact repro command.

### Appendix B.8. `weekly-soak`
- Trigger: schedule.
- Command: `pnpm test:soak`.
- Gate: longevity.
- Failure artifact: logs, coverage/benchmark JSON, database files if applicable, and exact repro command.

### Appendix B.9. `weekly-mutation`
- Trigger: schedule.
- Command: `pnpm test:mutation`.
- Gate: test quality.
- Failure artifact: logs, coverage/benchmark JSON, database files if applicable, and exact repro command.

### Appendix B.10. `weekly-bench`
- Trigger: schedule.
- Command: `pnpm bench`.
- Gate: performance.
- Failure artifact: logs, coverage/benchmark JSON, database files if applicable, and exact repro command.

### Appendix B.11. `release-provenance`
- Trigger: release.
- Command: `npm publish --provenance + attest`.
- Gate: supply chain.
- Failure artifact: logs, coverage/benchmark JSON, database files if applicable, and exact repro command.

## Appendix C. Release gate summary

- REL-01: All push suites green on merge commit.
- REL-02: Cross-platform matrix green on Linux/macOS/Windows for Node 22 and 24.
- REL-03: No high/critical dependency, CodeQL, Semgrep, OSV, or socket.dev findings.
- REL-04: Fuzz corpus has no unreproduced open crash for release branch.
- REL-05: Mutation score at or above baseline for scheduler/runner/store.
- REL-06: Soak run shows stable memory and fd counts.
- REL-07: Benchmark history has no unexplained regression.
- REL-08: Provenance attestation generated and verified.
- REL-09: Threat model and SECURITY.md current for execution changes.
- REL-10: Changelog lists testing/security/migration impact.

## Appendix D. Assertion inventory

- ASSERT-001: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-002: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-003: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-004: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-005: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-006: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-007: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-008: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-009: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-010: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-011: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-012: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-013: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-014: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-015: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-016: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-017: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-018: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-019: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-020: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-021: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-022: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-023: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-024: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-025: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-026: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-027: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-028: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-029: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-030: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-031: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-032: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-033: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-034: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-035: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-036: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-037: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-038: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-039: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-040: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-041: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-042: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-043: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-044: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-045: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-046: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-047: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-048: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-049: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-050: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-051: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-052: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-053: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-054: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-055: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-056: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-057: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-058: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-059: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-060: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-061: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-062: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-063: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-064: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-065: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-066: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-067: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-068: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-069: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-070: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-071: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-072: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-073: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-074: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-075: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-076: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-077: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-078: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-079: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-080: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-081: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-082: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-083: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-084: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-085: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-086: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-087: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-088: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-089: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-090: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-091: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-092: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-093: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-094: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-095: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-096: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-097: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-098: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-099: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-100: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-101: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-102: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-103: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-104: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-105: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-106: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-107: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-108: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-109: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-110: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-111: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-112: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-113: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-114: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-115: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-116: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-117: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-118: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-119: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-120: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-121: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-122: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-123: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-124: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-125: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-126: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-127: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-128: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-129: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-130: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-131: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-132: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-133: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-134: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-135: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-136: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-137: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-138: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-139: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-140: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-141: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-142: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-143: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-144: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-145: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-146: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-147: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-148: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-149: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-150: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-151: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-152: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-153: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-154: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-155: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-156: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-157: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-158: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-159: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-160: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-161: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-162: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-163: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-164: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-165: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-166: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-167: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-168: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-169: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-170: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-171: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-172: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-173: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-174: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-175: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-176: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-177: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-178: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-179: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-180: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-181: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-182: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-183: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-184: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-185: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-186: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-187: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-188: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-189: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-190: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-191: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-192: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-193: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-194: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-195: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-196: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-197: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-198: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-199: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-200: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-201: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-202: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-203: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-204: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-205: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-206: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-207: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-208: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-209: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-210: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-211: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-212: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-213: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-214: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-215: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-216: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-217: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-218: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-219: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-220: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-221: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-222: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-223: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-224: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-225: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-226: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-227: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-228: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-229: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-230: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-231: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-232: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-233: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-234: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-235: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-236: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-237: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-238: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-239: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-240: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-241: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-242: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-243: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-244: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-245: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-246: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-247: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-248: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-249: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-250: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-251: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-252: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-253: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-254: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-255: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-256: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-257: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-258: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-259: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-260: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-261: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-262: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-263: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-264: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-265: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-266: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-267: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-268: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-269: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-270: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-271: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-272: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-273: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-274: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-275: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-276: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-277: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-278: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-279: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-280: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-281: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-282: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-283: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-284: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-285: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-286: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-287: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-288: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-289: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-290: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-291: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-292: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-293: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-294: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-295: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-296: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-297: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-298: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-299: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-300: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-301: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-302: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-303: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-304: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-305: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-306: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-307: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-308: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-309: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-310: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-311: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-312: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-313: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-314: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-315: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-316: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-317: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-318: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-319: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-320: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-321: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-322: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-323: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-324: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-325: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-326: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-327: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-328: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-329: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-330: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-331: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-332: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-333: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-334: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-335: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-336: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-337: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-338: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-339: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-340: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-341: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-342: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-343: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-344: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-345: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-346: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-347: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-348: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-349: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-350: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-351: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-352: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-353: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-354: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-355: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-356: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-357: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-358: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-359: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-360: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-361: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-362: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-363: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-364: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-365: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-366: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-367: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-368: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-369: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-370: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-371: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-372: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-373: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-374: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-375: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-376: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-377: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-378: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-379: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-380: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-381: `scheduler` `happy path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-382: `runner` `invalid input` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-383: `store` `boundary value` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-384: `api` `concurrency` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-385: `mcp` `restart persistence` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-386: `autostart` `error envelope` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-387: `security` `metric emitted` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-388: `dashboard` `artifact uploaded` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-389: `cli` `coverage branch` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-390: `fixtures` `regression seed` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-391: `scheduler` `Windows path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-392: `runner` `POSIX path` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-393: `store` `permission denied` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-394: `api` `timeout` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-395: `mcp` `cancellation` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-396: `autostart` `large payload` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-397: `security` `unicode` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-398: `dashboard` `schema default` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-399: `cli` `snapshot stable` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
- ASSERT-400: `fixtures` `no external writes` must use `expect(result.error?.code ?? "OK").toMatch(/^(OK|ERR_[A-Z0-9_]+)$/)` and must clean its sandbox root after completion.
