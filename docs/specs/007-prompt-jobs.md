# 007: Prompt Jobs

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-09-28

Audience: contributors changing engine adapters, session handling, or prompt CLI surface
behavior. Non-duplication: this spec is the normative contract; for the mental model see
[concepts/execution.md](../concepts/execution.md), and for the adapter implementation see
[implementation/engines.md](../implementation/engines.md).

## Summary

Prompt jobs invoke a configured CLI engine with a natural-language prompt.
The engine's `type` selects an adapter for invocation, result interpretation,
and session handling. The built-in and default engine is Claude Code; custom
engines without a `type` use the generic `raw` adapter.

## Configuration and job input

- A prompt action requires a non-empty `prompt`. Its `engine` defaults to
  `config.defaultEngine`; an unknown name fails with `CONFIG_ENGINE_NOT_FOUND`.
- Engine names match `^[A-Za-z0-9_.-]+$`. An engine config contains `command`,
  optional `args` and `env`, and `type: "claude" | "raw"` (default `"raw"`).
  The built-in config contains only `claude: { command: "claude", args: [],
  env: {}, type: "claude" }`, with `defaultEngine: "claude"`. There is no
  built-in Copilot entry.
- `config.json` can set `defaults.overlap`, `defaults.timeoutSec`, and
  `defaults.retry`. Built-in values are `skip`, no timeout, and
  `{ max: 0, backoffSec: 30 }`. Explicit job input takes precedence over
  config defaults; CLI flags take precedence over job JSON. Values are resolved
  at creation and stored in the job. An update that omits a value preserves it.
- `reuseSession: true` requires `overlap: "skip"`. `queue` and
  `cancel-previous` fail validation. Every overlap skip records a terminal
  `skipped` run, distinct from a run that started and was `canceled`.
- Prompt jobs spawn directly with `shell: false`, stdin ignored, and
  environment precedence `process.env` < `engine.env` < `action.env`.
- The shared reserved-argument check rejects `-p`, `-r`, `--prompt`,
  `--session-id`, `--resume`, `--continue`, `--connect`, `--output-format`,
  and `--settings`, including long `--flag=value` forms, from `action.args`.
  Windows command-line length is checked before execution against a
  30,000-character limit.

## Adapter contract

`buildPromptRunCommand()` resolves the engine and dispatches by `engine.type`
through the adapter registry. Each adapter builds an invocation, parses the
process result, and resolves a session ID. The runner owns spawn, bounded and
redacted output capture, timeout, persistence, and retries. Engine-specific
command and result rules stay in adapters
([ADR 0002](../decisions/0002-prompt-only-jobs-and-engine-adapters.md)).

### Raw adapter

The raw adapter preserves generic CLI behavior:

```text
<command> ...engine.args <prompt> ...action.args [--session-id=<id>]
```

An engine that needs a prompt-taking flag places it last in `engine.args`.
Exit code zero means success; other exit codes mean failure. On success, the
adapter searches the captured output tail for generic `--session-id=<id>`,
`--session-id <id>`, or `session id: <id>` forms. If `reuseSession` is
requested and no ID is found, the run fails with `SESSION_ID_NOT_FOUND`.
Raw runs do not populate Claude usage fields.

### Claude adapter

The Claude adapter runs a non-interactive CLI process:

```text
claude ...engine.args -p <prompt> --output-format stream-json --verbose
  (--session-id <new-uuid> | --resume <existing-id>) ...action.args --settings <json>
```

Crontick assigns a UUID before each fresh Claude spawn and persists it on the
run, including when `reuseSession` is false. It never scrapes Claude output
for the initial ID. Before `--resume`, preflight confirms an earlier completed
Claude result for this job and a transcript at
`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`; the absolute cwd is
encoded by replacing every `/`, `\\`, `:`, and `.` with `-` (so a Windows
`C:\\Users\\me` cwd maps to `C--Users-me`). A missing eligible run or
transcript fails with `SESSION_NOT_FOUND` before spawn. There is no fallback
to a fresh session under the same ID.

The adapter scans the bounded `stream-json` output tail backwards for the last
complete `type: "result"` line. Exit code zero and `is_error !== true` means
success. Exit code zero with `is_error: true` means failure; the error comes
from `result` or `subtype`. Without a complete result, the adapter falls back
to exit-code status and records no usage. Only a complete result can make a
session eligible for resume; this includes a completed failed turn. Session
capture updates the job only if its action still matches the expected prompt,
engine, and args.

Complete Claude results may add `costUsd`, `turns`, `usageJson` (redacted
`usage` block serialized as JSON), `transcriptPath` (a pointer, not a data
source), and `engineStatus` (Claude `subtype`) to run records. `runs get`
exposes these on library, CLI, and MCP surfaces. `stats summary` and
`stats job` sum recorded cost and turns as `totalCostUsd` and `totalTurns`;
missing values contribute zero. They also report `canceled` and `skipped`
separately. `runs list` accepts a `skipped` status filter on each surface.
When a Claude run retries, cost, turns, and numeric usage counters accumulate
across attempts; the final attempt determines the run status and engine status.
Imported run history never grants Claude resume eligibility: a transcript can
prove its session ID but cannot prove which crontick job produced it. On import,
a Claude job with an untrusted stored session ID starts a fresh session. When
its overlap policy is `skip`, the new session is captured for later reuse.
An already-local completed run can still authorize its known session ID.

Crontick's `timeoutSec` and SIGTERM remain the run timeout. Jobs may pass
Claude's `--max-budget-usd` through `action.args` to cap cost. The adapter
does not grant elevated permissions by default; jobs opt in through engine
arguments such as `--permission-mode`. It appends ephemeral `--settings`
JSON with a `SessionEnd` hook that writes a completion marker for best-effort
restart recovery. This marker never determines a normal run's result and does
not make a session eligible for resume. Its live firing and payload still
require validation; when absent, restart reconciliation uses the existing
unknown-exit fallback ([ADR 0002](../decisions/0002-prompt-only-jobs-and-engine-adapters.md)).

## CLI and surface behavior

`jobs new` and `jobs update` use `--name` for schema `alias` and `--runner`
for `action.engine`. Old `--alias` and `--engine` switches fail, including
after `--`. `--every` accepts bare seconds or `s`/`m`/`h`/`d` suffixes.
Unknown long flags, with a following value when that token is not flag-shaped,
pass through to `action.args` in argv order with or without `--`. Positional
engine args can follow `--`. The reserved-argument check runs on the merged
args. Library and MCP callers pass `action.args` directly. See the
[CLI reference](../reference/cli.md) for examples.

## Failure and edge cases

| Case | Outcome |
|------|---------|
| Engine binary missing | Actionable run error names engine and command. |
| Unknown engine name | `CONFIG_ENGINE_NOT_FOUND` before spawn. |
| Reserved args or excessive Windows command length | Job validation error. |
| Raw reuse with no captured ID | Failed run with `SESSION_ID_NOT_FOUND`. |
| Claude resume with no eligible result or transcript | Failed run with `SESSION_NOT_FOUND` before spawn. |
| Overlap while active with `overlap: "skip"` | Terminal `skipped` run; active run continues. |
| Explicit `sessionId` with `reuseSession: true` | Notice in crontick log; no session capture. |
| Concurrent job edit during capture | Compare-and-swap declines the job mutation. |

## Acceptance criteria

- [x] Built-in config defines only `claude` (no Copilot fallback), with `defaultEngine: "claude"` (test file: `tests/unit/default-engine-config.test.ts`)
- [x] Engine registry resolves `type` to the `raw`/`claude` adapter, defaulting unset `type` to `raw` (test file: `tests/unit/engine-registry.test.ts`)
- [x] Raw adapter builds generic argv, treats exit code 0 as success, and extracts a session id from output when `reuseSession` is set (test file: `tests/unit/raw-adapter.test.ts`)
- [x] Claude adapter assigns a session id before spawn, builds `stream-json` invocation, parses the last complete result line, and populates `costUsd`/`turns`/`usageJson`/`transcriptPath`/`engineStatus` (test file: `tests/unit/claude-adapter.test.ts`)
- [x] Claude resume preflight rejects a session with no completed local result or missing transcript with `SESSION_NOT_FOUND` (test files: `tests/unit/claude-adapter.test.ts`, `tests/unit/prompt-resolution.test.ts`)
- [x] `reuseSession: true` requires `overlap: "skip"`; other overlap values fail job validation (test file: `tests/unit/job-input.test.ts`)
- [x] Reserved prompt args (`-p`, `-r`, `--prompt`, `--session-id`, `--resume`, `--continue`, `--connect`, `--output-format`, `--settings`) are rejected from `action.args` (test file: `tests/unit/job-input.test.ts`)
- [x] End-to-end prompt run against a fake engine binary records status, session, and usage fields (test file: `tests/unit/integration.prompt-e2e.test.ts`)
- [x] `stats summary`/`stats job` sum `costUsd`/`turns` and report `canceled`/`skipped` counts separately (test files: `tests/unit/run-usage-fields.test.ts`, `tests/unit/run-usage-surfaces.test.ts`)
- [x] `jobs new --runner` sets `action.engine`; the removed `--engine`/`--alias` flags fail (test file: `tests/unit/cli.test.ts`)

## Related

- [Job schema](../reference/job-schema.md)
- [Configuration](../reference/configuration.md)
- [Execution](003-execution.md)
- [ADR 0002: Prompt-only jobs and the engine adapter framework](../decisions/0002-prompt-only-jobs-and-engine-adapters.md)
