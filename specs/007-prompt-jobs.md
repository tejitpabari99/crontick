# 007: Prompt Jobs

- Status: Active
- Owner: crontick maintainers
- Last reviewed: 2026-07-25

## Summary

Prompt jobs are a first-class action kind (`kind: "prompt"`) that invoke a configured
prompt engine (e.g., GitHub Copilot CLI) with a natural-language prompt. Engine
configuration, argument construction, session reuse, and runtime validation are defined
here.

## Motivation

Prompt jobs enable LLM-powered scheduled tasks without requiring users to manually
construct CLI invocations. Engine abstraction allows swapping providers, and session
reuse enables multi-turn conversations across runs.

## Terminology

| Term | Definition |
|------|-----------|
| Prompt engine | An external CLI binary (e.g., `copilot`) invoked with the prompt text. |
| Engine config | `{ command, args, env }` defining how to invoke an engine. |
| Session ID | An opaque string identifying a conversation session for multi-turn reuse. |
| Session capture | Extracting a session ID from engine output on first run to persist for future runs. |
| Reserved args | Prompt/session flags managed by crontick that users MUST NOT pass in `args`. |

## Requirements

### Functional requirements

- **R-007-1**: A prompt action MUST have a non-empty `prompt` string.
- **R-007-2**: The `engine` field MAY be omitted; when omitted, `config.defaultEngine` MUST be used.
- **R-007-3**: Engine resolution MUST look up the engine name in `config.engines`; if not found, a `CONFIG_ENGINE_NOT_FOUND` error MUST be thrown.
- **R-007-4**: `buildPromptRunCommand()` MUST construct the command line as: `[engine.command, ...engine.args, action.prompt, ...action.args]`. Because `action.prompt` is appended immediately after `engine.args`, any engine that requires an explicit prompt-taking flag (for example `copilot -p` / `copilot --prompt`) MUST place that flag as the final configured engine arg, with any other non-interactive flags before it. If `action.sessionId` is set, `--session-id=<id>` MUST be appended.
- **R-007-5**: The spawned process MUST use `shell: false`; the engine command is invoked directly.
- **R-007-6**: Engine environment variables (`engine.env`) MUST be merged into the spawn env (below `action.env`, above `process.env`).
- **R-007-7**: The `args` field MUST NOT contain reserved prompt args: `-p`, `--prompt`, `--session-id`, `-r`, `--resume`, `--continue`, `--connect`, or their `=`-prefixed variants.
- **R-007-8**: Validation MUST reject args containing reserved flags with a descriptive error.
- **R-007-9**: On Windows, the total estimated command-line length (prompt + engine args + session flag) MUST NOT exceed 30,000 characters. Validation MUST reject with an actionable message if exceeded.
- **R-007-10**: When `reuseSession=true` and no `sessionId` is set, the runner MUST capture the session ID from engine stdout/stderr output after a successful run.
- **R-007-11**: Session ID extraction MUST use the regex in `extractSessionId()` against the last 128KB of combined output.
- **R-007-12**: If session capture succeeds, the job definition MUST be updated: `sessionId` set to the captured value and `reuseSession` set to `false`.
- **R-007-13**: If `reuseSession=true` but session ID extraction fails (output does not contain a session ID), the run MUST be marked `failed` with error `SESSION_ID_NOT_FOUND`.
- **R-007-14**: If an explicit `sessionId` is already set and `reuseSession=true`, a notice MUST be logged to stderr but session capture MUST NOT occur.
- **R-007-15**: Session capture MUST only persist if the current job action still matches the expected prompt/engine/args (compare-and-swap to prevent race conditions).
- **R-007-16**: If engine ENOENT occurs, the error MUST name the engine and command, and suggest installing or updating the config.
- **R-007-17**: The built-in default config MUST define engine `copilot` with `{ command: "copilot", args: ["--allow-all-tools", "-p"], env: {} }`.
- **R-007-18**: Engine names MUST match `^[A-Za-z0-9_.-]+$`.
- **R-007-19**: The built-in `copilot` engine MUST NOT be removable via `removeEngine`.
- **R-007-20**: `addEngine` MUST reject if the engine name already exists; `updateEngine` MUST reject if it does not exist.
- **R-007-21**: Removing the `defaultEngine` MUST be rejected with `CONFIG_VALIDATION_ERROR`.

### Non-functional requirements

- **R-007-22**: Prompt command construction SHOULD be testable without spawning a real engine process.
- **R-007-23**: Session capture SHOULD be resilient to partial/noisy engine output.

## Behavior

**Engine resolution flow**:
1. Load config (from file or built-in default).
2. Determine engine name: `action.engine ?? config.defaultEngine`.
3. Look up `config.engines[engineName]`.
4. Construct argv: `[engine.command, ...engine.args, prompt, ...action.args, --session-id=X?]`. For engines with an explicit prompt flag, the final `engine.args` entry is that flag so the appended `prompt` token becomes its value.

**Session capture flow**:
1. On run start, if `reuseSession=true` and no `sessionId`: enable capture mode.
2. Accumulate last 128KB of stdout+stderr in memory.
3. On successful exit (code 0): extract session ID via regex.
4. If found: call `store.tryCapturePromptSession(jobId, action, sessionId)`.
5. `tryCapturePromptSession` compares current job action to expected; if match and
   no existing sessionId, upserts job with captured sessionId and reuseSession=false.
6. Append `[crontick] captured session id: <id>` to run stdout log.

**Validation flow (schema-level)**:
1. Zod `PromptActionSchema` runs `addPromptRuntimeIssues` superRefine.
2. Checks for reserved args in `action.args`.
3. Estimates Windows command-line length; rejects if over 30,000 chars.

## Inputs and outputs

**Prompt action input fields**: `prompt`, `engine?`, `args[]`, `sessionId?`, `reuseSession`, `cwd?`, `env?`, `envFile?`, `timeoutSec?`.
**buildPromptRunCommand output**: `{ command, args, env, engine }` (PromptRunCommand).
**Session capture output**: Mutated job definition in store (sessionId written, reuseSession cleared).

## Edge cases and failure modes

- Engine not installed (ENOENT): Run fails with actionable error naming the engine binary.
- Engine not in config: `CONFIG_ENGINE_NOT_FOUND` thrown before spawn.
- Prompt exceeds Windows cmd-line limit: Rejected at validation time.
- Reserved arg in args array: Rejected at validation time.
- Session ID not found in output: Run marked failed with `SESSION_ID_NOT_FOUND`.
- Session capture race (job modified between run start and capture): `tryCapturePromptSession` returns false; no mutation.
- Engine produces no output: Session capture fails if reuseSession=true.
- Engine exits non-zero: No session capture attempted; run is `failed`.

## Acceptance criteria

- [x] buildPromptRunCommand constructs correct argv (test files: `tests/config.test.ts`, `tests/default-engine-config.ctd-016.test.ts`)
- [x] Reserved args rejected by schema (test file: `tests/job-input.test.ts`)
- [x] Windows command-line limit validated (test file: `tests/job-input.test.ts`)
- [x] Session ID extraction from engine output (test file: `tests/prompt-session.test.ts`)
- [x] Session capture persists to job (test file: `tests/prompt-session.test.ts`)
- [x] Engine not found error is actionable (test file: `tests/runner.test.ts`)
- [x] Built-in copilot engine cannot be removed (test file: `tests/config.test.ts`)
- [x] addEngine rejects duplicate (test file: `tests/config.test.ts`)
- [x] updateEngine rejects non-existent (test file: `tests/config.test.ts`)
- [x] End-to-end prompt job run with session capture (test file: `tests/integration.prompt-e2e.test.ts`)
- [x] reuseSession=true with explicit sessionId logs notice (test files: `tests/mcp.test.ts`, `tests/cli.test.ts`)

## Out of scope

- Prompt content/quality (crontick is transport-agnostic to prompt semantics).
- Engine installation/management.
- Multi-engine parallel invocation.

## Open questions

None.

## Related

- [001-job-definition.md](001-job-definition.md)
- [003-execution.md](003-execution.md)
- `../docs/reference/`
- `../docs/concepts/`
