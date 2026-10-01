# Engines

Implements: `src/engines/types.ts`, `src/engines/registry.ts`, `src/engines/raw-adapter.ts`,
`src/engines/claude-adapter.ts`, `src/config.ts` (`resolvePromptRunCommand`)

Audience: contributors adding or changing a prompt-engine adapter. Non-duplication: for *why*
adapters exist see [ADR 0002](../decisions/0002-prompt-only-jobs-and-engine-adapters.md); for the runner's
side of the contract see [implementation/prompt-execution.md](./prompt-execution.md); for the
user-facing behavior contract see [specs/007-prompt-jobs.md](../specs/007-prompt-jobs.md).

---

## Why adapters

A prompt job's engine has its own CLI flags, output shape, and session model. The daemon core
never branches on engine name (`if (engine === 'claude')`); instead it asks one polymorphic
`EngineAdapter` to build the invocation and interpret the result. Adding an engine means adding
one adapter and a registry entry, not touching the runner or config resolution.

## The `EngineAdapter` contract (`src/engines/types.ts`)

```ts
abstract class EngineAdapter {
  abstract reservedArgs(): ReadonlySet<string>;
  abstract buildInvocation(prompt: string, opts: EngineOptions): EngineInvocation;
  abstract parseResult(exitCode: number | null, stdout: string, stderr: string): EngineResult;
  abstract resolveSessionId(opts: EngineOptions, result: EngineResult): string | undefined;

  canCaptureSession(result: EngineResult): boolean;        // default: result.status === 'success'
  resumeTranscriptPath(cwd: string, sessionId: string): string | undefined; // default: undefined
  resumableSessionId(result: EngineResult): string | undefined;             // default: undefined
  parseStreamEvent?(line: string): StreamEvent | undefined;                 // optional; absent = generic plain-text stdout handling (runner warns)
}
```

`EngineOptions` carries the resolved `command`/`engineArgs`/`env` from config, the job's
`args`/`sessionId`/`reuseSession`, and `runId`/`jobId`/`dataDir` for adapters that need run
context (Claude's completion-marker path). `EngineInvocation` is `{ command, args, env,
sessionId? }` -- the pre-assigned session id the runner persists as soon as the child exists.
`EngineResult` is `{ status, exitCode?, error?, sessionId?, costUsd?, turns?, usage?,
engineStatus? }`.

## Registry (`src/engines/registry.ts`)

```ts
export const ENGINE_ADAPTERS: Readonly<Record<EngineConfig['type'], EngineAdapter>> = {
  raw: new RawAdapter(),
  claude: new ClaudeAdapter(),
};
```

`config.engines.<name>.type` (`"raw" | "claude"`, default `"raw"`) selects the adapter.
`resolvePromptRunCommand()` in `src/config.ts` loads config, resolves the named engine (or
`defaultEngine`), looks up its adapter, and calls `buildInvocation()`; the runner then spawns
the returned command/args/env with `shell: false`. `claude` is the sole built-in engine
(`BUILT_IN_CONFIG.engines.claude`, `defaultEngine: "claude"`) -- there is no built-in Copilot
entry.

## Raw adapter

Preserves the original engine-agnostic behavior: `[...engineArgs, prompt, ...args]`, plus
`--session-id=<id>` when a session id is set. Exit code 0 is success; anything else (or no exit
code) is failure. On success, `extractSessionId()` regex-searches the last 128 KB of combined
output for `--session-id=<id>`, `session id: <id>`, or `started/created/resumed session <id>`.
`canCaptureSession`/`resumeTranscriptPath` use the base class defaults (no resume support).

## Claude adapter

Runs Claude non-interactively: assigns a UUID session id before spawn (never scraped from
output), passes `-p <prompt> --output-format stream-json --verbose`, and `--session-id <uuid>`
or `--resume <id>` depending on whether a prior session is being reused. It reserves
`--output-format` and `--settings` in addition to the raw adapter's reserved set, since it
manages both itself.

`parseResult` scans the bounded output tail backwards for the last complete `type: "result"`
JSON line; exit 0 with `is_error !== true` is success, and a complete result contributes
`costUsd`, `turns`, `usage`, and `engineStatus` (Claude's `subtype`). Without a complete line it
falls back to exit-code status with no usage. `resumableSessionId`/`canCaptureSession` only
return a value once a complete result was parsed -- this is what "resume eligible" means:
`resumeTranscriptPath(cwd, sessionId, env?)` resolves
`<base>/projects/<encoded-cwd>/<sessionId>.jsonl` with `<base>` = `$CLAUDE_CONFIG_DIR` or `~/.claude` (see `src/engines/claude-transcript.ts`),
and the runner's resume preflight (`SESSION_NOT_FOUND`) checks this before ever spawning with
`--resume`.

`buildInvocation` also appends an ephemeral `--settings` JSON registering a `SessionEnd` command
hook. The hook is a plain helper script, `<dataDir>/hooks/session-end.cjs` (fixed content, no
embedded paths, no `eval`), rewritten idempotently at daemon start and again by `buildInvocation`
for real runs. The hook command is `"<node>" "<helper>" "<markerPath>"` (double quotes on Windows,
single-quote escaping on POSIX). The helper reads `exit_status`/`session_id`/`transcript_path` from hook stdin and
writes `claudeCompletionMarkerPath(dataDir, runId)` -- a private file, never the user's own Claude
settings. If the helper cannot be written, or the data dir contains `"`, `$`, a backtick or a
newline, `--settings` is omitted entirely (the hook is best-effort and a run still proceeds).
The stored and displayed command (run record, diagnostic logs) shows `--settings <session-end-hook>`
instead of the JSON value.

Observability notes: crontick does not store the engine's raw stdout/stderr; the engine keeps its own transcript
(`transcriptPath`). Only the parsed output is stored (`run_outputs`), and crontick-side events go to a
per-**job** file (all runs appended; see `resolveJobLogPath` in `src/daemon/job-log-file.ts`, null when
`logging.fileEnabled=false`). Cost,
turns and usage are reported by Claude's final `result` event (`total_cost_usd`, `num_turns`,
`usage`); crontick computes nothing per run, sums cost/turns and adds numeric usage counters across
retry attempts, and measures `durationMs` itself as wall clock. `normalizeUsage` (`src/run-output.ts`)
maps the raw usage block to display counts; storage keeps the raw `usageJson`. `totalTurns` in job
stats is the sum of `turns` over the job's last 100 runs. This marker is a best-effort signal consumed only by restart reconciliation (see
[prompt-execution.md](./prompt-execution.md#adopting-runs-across-a-restart) and
[ADR 0002](../decisions/0002-prompt-only-jobs-and-engine-adapters.md)); a normal run's
outcome always comes from `parseResult`, never the marker.

## Adding an engine

1. Add a class extending `EngineAdapter` in `src/engines/`.
2. Register it in `ENGINE_ADAPTERS` keyed by a new `EngineConfigSchema.type` enum value.
3. Add config/schema/docs for the new `type` value (`src/schemas/config.ts`,
   [reference/configuration.md](../reference/configuration.md)).
4. Add adapter unit tests plus an end-to-end prompt test against a fake binary (see
   `tests/unit/claude-adapter.test.ts`, `tests/unit/raw-adapter.test.ts`,
   `tests/unit/integration.prompt-e2e.test.ts`).

No runner or config-resolution code should need to branch on the new engine name.
