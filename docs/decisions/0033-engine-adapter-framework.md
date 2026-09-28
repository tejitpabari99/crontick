# 0033: Select prompt behavior through engine adapters

- Status: Accepted
- Date: 2026-09-28

## Context

Prompt execution previously assembled one generic argv sequence and scraped
session IDs from output with regular expressions. That kept custom CLIs usable
but could not interpret Claude's structured result, cost, or session semantics.
Putting engine-specific branches in config resolution and the daemon runner
would make each new engine a cross-module change.

## Decision

Add a typed `EngineAdapter` contract and a registry keyed by
`EngineConfig.type`. Config resolution uses the registry and asks the adapter
to build an invocation; the runner asks the same adapter to parse the captured
result and resolve a session. The runner retains process spawning, stdin
isolation, bounded/redacted capture, timeout, retry, and persistence. The
registry contains `RawAdapter` and `ClaudeAdapter` today. An omitted type
resolves to `raw`, preserving existing custom engine behavior.

`RawAdapter` retains generic argv ordering, exit-code outcomes, and regex
session extraction. `ClaudeAdapter` owns non-interactive `stream-json`
invocation, pre-assigned session IDs, complete-result interpretation, and
transcript-backed resume preflight. Claude is the sole built-in engine and the
default. Crontick grants no elevated Claude permissions; jobs opt in through
engine arguments.

The shared job schema continues to reject crontick-managed prompt flags,
including `--output-format` and `--settings`, before adapter selection.
This keeps validation pure and consistent across CLI, MCP, and library input.

## Alternatives considered

- **Infer type from the executable name:** wrappers and renamed binaries
  would select the wrong behavior.
- **Add Claude branches to the runner and config helper:** each future engine
  would expand the shared execution code and make result rules harder to test.
- **Require a type on every configured engine:** existing custom configs would
  change behavior or fail validation.
- **Use the Claude Agent SDK:** would add a runtime dependency and use a second
  execution transport while the daemon already manages CLI children.

## Consequences

New engine semantics can be added behind a registry entry while keeping the
core process lifecycle shared. Existing custom engines remain raw by default.
The adapter contract is internal; `src/index.ts` remains the public API
boundary. The built-in default changes from Copilot to Claude, so users who
relied on the old default must set their desired engine explicitly.

The Claude completion hook is a best-effort restart signal only
([ADR 0032](0032-claude-completion-marker-for-restart-recovery.md)); ordinary
run outcomes come from the process exit and parsed result. Resume safety,
overlap status, passthrough, and CLI naming choices are recorded separately in
ADRs 0029–0031.

## Related

- [Prompt jobs spec](../specs/007-prompt-jobs.md)
- [ADR 0008](0008-prompt-jobs-pluggable-engines.md)
- [ADR 0028](0028-prompt-only-jobs.md)
