# 0002: Prompt-only jobs and the engine adapter framework

- Status: Accepted
- Date: 2026-09-28
- Supersedes: former ADRs 0008, 0018, 0019 (its exec-specific guidance is obsolete;
  its `--arg`-is-primary guidance for prompt args carries forward), 0021, 0025, 0028,
  0029, 0030, 0031, 0032, 0033.

## Context

crontick originally shipped three job action kinds: `script` (temp file + shell),
`exec` (direct spawn, no shell), and `prompt` (AI engine invocation). The owner
subsequently decided to pivot crontick fully to its AI-native positioning -- every job
is a prompt job -- and to build a proper per-engine adapter framework in place of one
generic, regex-scraping code path. That pivot, and the identity/argument/session
mechanics that go with running prompts reliably and repeatably, are the subject of this
ADR. (Everything about *how the daemon runs and stays up* regardless of what a job does
is [ADR 0001](0001-architecture-and-runtime-model.md).)

## Decision

### Prompt-only: script/exec removed

`script` and `exec` action kinds, and all their supporting machinery (temp-file
writing, shell resolution, the PowerShell exit-code/UTF-8 wrapper, the direct-spawn exec
dispatch, the `--script`/`--exec`/`--shell` CLI flags and matching MCP validation
branches), are removed entirely. `ActionSchema` is a discriminated union with a single
member, keyed `kind: 'prompt'` -- the discriminant is kept explicit (not flattened) so
job JSON stays self-describing and forward-compatible with a possible future action
kind, at no cost today. Creating or updating a job with `kind: 'script'`/`kind: 'exec'`
fails schema validation. This is a deliberate, owner-signed-off exception to the "removed
features stay removed" rule (`AGENTS.md` rule 8) -- this ADR is that sign-off record.
Reintroducing a command-execution action kind requires a fresh sign-off explaining why
this rationale no longer applies. Alongside this, the Copilot-specific distribution
mechanism (the `plugin/` marketplace descriptor/installer and `.github/skills/`) was
removed from this branch (history preserved on `users/tejitpabari/copilot-init`), and
`src/skill/SKILL.md` was reworded to be engine-neutral.

### Job identity: GUID plus alias, duplicate create requires force

A job's `id` is an immutable, server-assigned GUID (`node:crypto randomUUID()`), never
user-supplied; it is the sole primary key in JSON persistence, in SQLite, and for
`run.jobId`. `alias` is an optional, user-editable, unique-among-live-jobs kebab-case
name; when omitted, crontick auto-generates one. Any identifier-accepting input (CLI
positional, MCP `id`, HTTP path segment, run filters) resolves a GUID match first, then
an alias, returning `JOB_NOT_FOUND` otherwise. Because run history is tied to the GUID,
deleting and recreating a job (even reusing the same alias) never inherits the old job's
history or dashboard status. Separately, creating a job with an id that already exists is
rejected (`JOB_ALREADY_EXISTS`) on every surface (CLI, library, MCP, HTTP) unless the
caller passes explicit `force` -- create is no longer a silent upsert, since silently
replacing a live job's schedule/action/retry policy is a real, easy-to-trigger data-loss
mode (accidental re-run of a setup script, a copy/pasted id). Schedule validation still
runs before persistence even with `force` set, so an invalid replacement cannot destroy
the existing job and then fail.

### Argument passing: `--arg` primary, plus unknown-option passthrough

`--arg <value>` (repeatable) is the primary, always-correct way to pass arguments to a
prompt job from the CLI -- verified to round-trip spaces, embedded quotes, leading
dashes, and flag-like values across every real entry point (`crontick.ps1`,
`crontick.cmd`, `npx crontick`), unlike the `--` convention, which two independently
verified Windows shim defects (PowerShell drops a literal `--`; `cmd.exe` strips embedded
quotes) make unsafe as *the* primary mechanism. `--` still works as a convenience where
its known caveats don't apply, but the two sources cannot be combined in one command.
Beyond that, `jobs new`/`jobs update` also accept any long option crontick does not
itself recognize (with or without a preceding `--`) and forward it, and its next token
when not flag-shaped, verbatim and in original order into `action.args` -- because
prompt engines add flags independently of crontick releases, and a fixed CLI mapping
would need a crontick release for every engine flag. All three argument sources (`--arg`,
`--`, unknown-option passthrough) run through the same reserved-argument validation,
which rejects crontick-managed flags a job must never override, including
`--output-format` and `--settings` (which the Claude adapter itself controls) and the
retired `--job-env-file`. crontick adds no engine permission flag by default; a job opts
into elevated engine permissions only through explicit passthrough arguments.

### CLI naming: `--name` and `--runner`

`jobs new`/`jobs update` use `--name` for the job's `alias` field and `--runner` for the
prompt action's `engine` field (previously `--alias`/`--engine`). There is no
compatibility alias for the old flags -- they are rejected as unknown options, before
engine-argument passthrough would otherwise silently absorb them as literal engine
arguments -- because crontick is pre-1.0 with no released users to preserve compatibility
for.

### Engine adapters: Claude as the sole built-in engine

Prompt execution goes through a typed `EngineAdapter` contract and a registry keyed by
`EngineConfig.type`, rather than generic argv concatenation plus output-scraping regexes
for every engine alike. The core lifecycle (build invocation -> spawn -> track ->
detect completion -> extract session id/result/usage -> record the run) is fixed and
engine-agnostic; each adapter overrides only what differs for it. The runner keeps
ownership of process spawning, stdin isolation, bounded/redacted output capture,
timeout, and retry -- an adapter never reaches around it. Two adapters exist:
`RawAdapter` (generic argv ordering, exit-code outcomes, regex session-id extraction --
today's original behavior, still the default for any unrecognized/custom `type`) and
`ClaudeAdapter` (non-interactive `stream-json` invocation, pre-assigned session ids
rather than scraped ones, structured result/cost/token/turn parsing, and transcript-
backed resume preflight). Claude is the sole built-in configured engine and the default
(`BUILT_IN_CONFIG.defaultEngine === 'claude'`); Copilot is no longer a built-in.

### Session reuse: overlap must be `skip`, completion marker is best-effort only

A prompt job with `reuseSession: true` must also set `overlap: "skip"` (enforced by
schema validation on create/update) -- `queue` could run a later turn against a session
whose state changed while waiting, and `cancel-previous` could interrupt a turn mid-way
and leave the reused session incomplete; neither is safe to allow with session reuse.
Separately, an overlap-skipped fire (one that never started a process) is now recorded
with its own terminal status, `skipped`, distinct from `canceled` (which remains for
explicit cancellation, `cancel-previous`, and orphan reconciliation) -- the two describe
different things (discarded vs. terminated-after-starting) and are reported separately in
run filters and stats. Finally, because the daemon can lose a child's exit code if it
stops before the child finishes, each Claude invocation registers a `SessionEnd` command
hook (via inline `--settings`, never touching the user's own Claude settings) that writes
`{exitStatus, sessionId}` to the crontick data directory; restart reconciliation accepts
that marker only when its session id matches the persisted run and its exit status is a
valid integer 0-255. This is a best-effort restart-recovery signal only -- a normal run's
outcome always comes from `parseResult` and the real process exit, never the marker, and
explicit cancellation always overrides it.

## Alternatives considered

- **Keep `script`/`exec` as a general-purpose escape hatch alongside `prompt`.**
  Rejected: maintaining two structurally different execution models contradicts the
  owner's explicit prompt-only product direction and keeps a maintenance/surface-parity
  cost for a feature set outside the product's focus.
- **Infer engine adapter type from the executable name.** Rejected: wrappers and renamed
  binaries would select the wrong behavior; an explicit `type` on the engine config is
  unambiguous.
- **Add Claude-specific branches directly to the runner/config resolver.** Rejected: this
  is exactly the pattern the adapter framework exists to avoid -- every future engine
  would expand shared execution code and make result handling harder to test in
  isolation.
- **Permit `queue`/`cancel-previous` with session reuse.** Rejected for the reasons above
  -- both can leave a reused session in an unsafe or inconsistent state.
- **Keep `--` as the only/primary argument mechanism.** Rejected: two independently
  verified Windows shim defects make it unsafe as the sole recommended path; `--arg` is
  correct everywhere at the cost of being more verbose for a short argument list.

## Consequences

**Easier:** one execution model to reason about, test, and document; adding an engine
adapter is additive (a registry entry), not a cross-module change; run history can never
bleed across a job delete/recreate; accidental duplicate creates fail safely; new engine
CLI flags need no crontick release; restart recovery can now recover a real exit code for
a Claude run that finished while the daemon was down.

**Harder:** a user who wants crontick to run an arbitrary shell command directly must
front it with a prompt engine, with no automatic migration for old `script`/`exec` job
JSON; two argument-passing flags (`--arg`, unknown-option passthrough) exist alongside
`--`, each with its own precedence rule; existing scripts using the old `--alias`/
`--engine`/`--script`/`--exec` flags must be updated with no compatibility shim.

**Impossible (by design):** reintroducing `script`/`exec` without fresh, explicit
sign-off; combining `reuseSession: true` with `queue`/`cancel-previous`; a completion-
marker hook ever determining a normal run's outcome or making a session eligible for
resume on its own.

## Revisit when

- A concrete need emerges for direct shell/command execution that no prompt engine can
  reasonably front -- reintroducing it needs fresh sign-off per `AGENTS.md` rule 8.
- An engine adapter can prove a richer session-concurrency policy is safe, opening the
  door to permitting `queue`/`cancel-previous` with session reuse.
- The Claude completion-hook firing semantics and payload need owner live-validation in
  `-p` mode; until then, an absent or invalid marker keeps the prior unknown-exit
  fallback.
- A third built-in engine adapter is added -- confirm the registry contract (not the
  runner) is still the right place for its engine-specific behavior.
