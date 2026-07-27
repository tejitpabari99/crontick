# 0008: Introduce prompt jobs with pluggable prompt engines

- Status: Accepted
- Date: 2026-07-25

## Context

crontick's original job model supported `script` (shell command) and `exec` (direct
binary) actions. With the rise of LLM-based development tools (GitHub Copilot CLI,
Claude Code, custom agents), users want to schedule natural-language prompts to run on a
cron schedule -- e.g., "summarize yesterday's PRs every morning at 9 AM."

This requires a third action kind that:

1. Accepts a prompt string (or reads from a file).
2. Routes execution to a configurable CLI engine (copilot, claude, custom).
3. Supports session reuse for multi-turn context across scheduled runs.

## Decision

Add `action.kind: "prompt"` as a first-class job action. The schema
(`src/schemas/job.ts`) defines `PromptActionSchema` with:

- `prompt: string` -- the natural-language instruction (persisted; never `promptFile`).
- `engine?: string` -- name of a configured engine (defaults to `config.defaultEngine`).
- `args: string[]` -- raw passthrough arguments to the engine CLI.
- `sessionId?: string` -- explicit session identifier for multi-turn context.
- `reuseSession: boolean` -- if true, daemon extracts session ID from the first run's
  output and reuses it on subsequent ticks.

Engine resolution uses the config system (ADR-0007):

```json
{ "engines": { "copilot": { "command": "copilot", "args": [], "env": {} } } }
```

`buildPromptRunCommand()` in `src/config.ts` assembles the final command line from
engine config + job-level overrides.

Prompt-file normalization (`src/job-input.ts`) reads `--prompt-file` at creation time
and stores the resolved text as `prompt`, ensuring jobs are self-contained.

## Alternatives considered

**Webhook/HTTP action.** POST a prompt to an API endpoint. More flexible but requires
the user to run an HTTP server, manage auth tokens, and handle responses -- too heavy
for the "schedule a CLI prompt" use case.

**Plugin/extension architecture.** Generic action plugins that users register. More
extensible but premature -- prompt jobs cover the immediate AI-agent use case without
the complexity of a plugin API.

**Inline script that shells out to the engine.** Users could write
`script: "copilot -m 'summarize PRs'"`. Works but loses structured session management,
engine configuration, and platform-safe command construction (Windows cmd-line length
limits validated in `src/prompt-runtime.ts`).

## Consequences

**Easier:**

- Scheduling LLM prompts is a single `crontick new` command with `--prompt`.
- Engine configuration is centralized -- changing the engine binary updates all prompt
  jobs.
- Session reuse enables multi-turn workflows across scheduled runs without user
  intervention.

**Harder:**

- The runner must understand prompt-specific semantics (session extraction regex in
  `src/daemon/prompt-session.ts`).
- Engine availability is not validated at job creation time -- a misconfigured engine
  fails only at run time.
- Windows cmd-line length limits require pre-flight validation (`prompt-runtime.ts`).

**Impossible:**

- Running a prompt job without a configured engine binary on PATH.

## Revisit when

- A standard emerges for programmatic LLM tool invocation (beyond CLI subprocess) that
  would allow in-process prompt execution without shelling out.
- The number of action kinds grows beyond 3-4 and a plugin architecture becomes
  justified.
- Session management needs become complex enough to warrant a dedicated session store
  rather than regex extraction from stdout.
