# 0028: crontick becomes prompt-only; remove `script`/`exec` action kinds and the Copilot plugin

- Status: Accepted
- Date: 2026-09-27

## Context

crontick originally shipped three job action kinds -- `script` (temp file + shell),
`exec` (direct spawn, no shell), and `prompt` (AI engine invocation) -- plus a
Copilot-specific distribution mechanism: a `plugin/` marketplace descriptor and
installer (`plugin/install.mjs`, `plugin.json`) that installed the bundled skill into
`~/.copilot`, a `.github/skills/` folder of Copilot repo skills used for this
project's own development workflow, and session-ID capture logic in
`src/daemon/prompt-session.ts` tuned specifically to the Copilot CLI's stats-footer
`--resume=<uuid>` output form.

The owner has decided to pivot crontick fully to its AI-native positioning: every job
is a prompt job. Carrying `script`/`exec` alongside `prompt` meant maintaining two
fundamentally different execution models (shell/file-based vs. engine-command-based)
in the runner, schema, CLI, MCP, and test suite, for a shell/command-runner feature
set that is not the product's focus and that any general-purpose task runner already
covers. Similarly, the Copilot plugin and its skills were a distribution mechanism for
exactly one engine host; the next phase of this project will redesign session/engine
handling around a Claude Code adapter, so the Copilot-specific plumbing (plugin
installer, repo skills, and the Copilot-specific resume-hint regex) is removed now
rather than carried forward speculatively.

This is an explicit, signed-off exception to AGENTS.md rule 8 (a removed feature must
not be reintroduced without sign-off): the `script`/`exec` removal is itself the
signed-off decision this ADR records, and the prior Copilot plugin work is preserved,
unmodified, on branch `users/tejitpabari/copilot-init` (already pushed) rather than
deleted from history.

## Decision

1. **`script` and `exec` action kinds are removed entirely.** `ActionSchema`
   (`src/schemas/job.ts`) is now a discriminated union with a single member,
   `PromptActionBaseSchema`. `kind: 'prompt'` is deliberately kept as an explicit
   discriminant (rather than flattening the action shape now that it's the only
   kind) so job JSON stays self-describing, forward-compatible with a future action
   kind, and unchanged for any external tooling that reads `action.kind`. Creating or
   patching a job with `kind: 'script'`/`kind: 'exec'` now fails schema validation
   with a clear `VALIDATION_ERROR` (see `tests/unit/job-input.test.ts`, "rejects the
   removed script and exec action kinds").
2. All script/exec-specific runner machinery is removed: temp-file writing under
   `<dataDir>/tmp/scripts/`, shell resolution (`resolveShell`/`resolveShellExt`), the
   PowerShell wrapper (`buildPowerShellScriptWrapper`) that normalized `exit N`
   semantics and UTF-8 output encoding, and the direct-spawn `exec` dispatch branch.
   The `tmp/scripts` directory is no longer created (`ensureDirs()` in
   `src/paths.ts`). The generic `isPowerShellHostCommand()` detached-spawn exception
   (ADR 0020) is *not* removed -- it is keyed off the resolved spawn command's
   basename, not the action kind, so it still applies if a prompt engine's own
   configured command happens to be `pwsh`/`powershell.exe`.
3. All script/exec CLI flags, MCP tool validation branches, and job-input
   normalization paths (`--script`, `--exec`, `--shell`, `resolveActionArgs`'s
   exec-specific branches) are removed. Prompt jobs keep everything they already
   had: engine resolution, `env`/`envFile`/`cwd`/`timeoutSec`, retry, overlap policy,
   output capture and redaction, and session reuse.
4. **Copilot-specific distribution artifacts are removed from this branch** (history
   preserved on `users/tejitpabari/copilot-init`): `plugin/` (descriptor, installer,
   README) and its test (`tests/unit/plugin-install.test.ts`), and `.github/skills/`
   (Copilot repo skills for this project's own docs/review workflow). `src/skill/
   SKILL.md` (the bundled LLM skill, still shipped -- it is generic guidance for
   driving the `crontick` CLI, not a Copilot-specific artifact) is reworded to be
   engine-neutral and no longer describes installing itself to `~/.copilot`.
5. **Session-ID capture is reduced to a minimal, engine-agnostic implementation.**
   `extractSessionId()` (`src/daemon/prompt-session.ts`) drops the Copilot CLI's
   `--resume=<uuid>` stats-footer pattern (and the optional `copilot` token in the
   "started/created/resumed session" pattern), keeping only generic
   `--session-id=<id>`/`--session-id <id>` and "session id: X" / "started/created/
   resumed session X" forms. This is explicitly a placeholder: the next phase
   redesigns session handling around a Claude Code adapter, so nothing new is built
   here beyond the generic fallback.
6. **`BUILT_IN_CONFIG`'s default engine stays `copilot`** (`src/config.ts`) -- the
   owner's call is that engine configuration is changeable independently of this
   removal and does not need to move in lockstep with it.
7. Packaging: `package.json#files` drops `plugin/**`; `scripts/verify-tarball.mjs`
   no longer checks for `plugin/install.mjs`; `AGENTS.md`'s packaging-rules file
   allowlist is updated to match.

## Alternatives considered

**Keep `script`/`exec` alongside `prompt` as a general-purpose escape hatch.**
Rejected: the owner's explicit direction is a prompt-only product; keeping a second,
structurally different execution model (temp files, shell resolution, PowerShell
exit-code/encoding normalization) solely as a fallback contradicts that positioning
and keeps the surface-parity and test-maintenance cost of a feature set the product
no longer wants to support.

**Drop the `kind` discriminant now that only `prompt` exists.** Rejected for now:
flattening the schema would be a larger, harder-to-reverse breaking change to job
JSON shape than keeping an explicit (if currently singleton) discriminated union, and
keeping `kind: 'prompt'` costs nothing while leaving room for a future action kind
without another migration.

**Delete the Copilot plugin/skills outright instead of preserving them on a
branch.** Rejected: the plugin and skills represent real prior work that may be
revisited or referenced later (e.g. when designing the Claude Code adapter);
preserving them on `users/tejitpabari/copilot-init` costs nothing and avoids
permanently losing that history from any branch.

**Build a full Claude Code session-ID adapter now, in place of the generic
fallback.** Rejected: out of scope for this pass -- the owner has flagged that the
next phase redesigns session handling around a specific adapter, so building
speculative engine-specific logic here would likely be thrown away.

## Consequences

**Easier:**

- One execution model (prompt + engine) to reason about, test, and document across
  the runner, schema, CLI, and MCP surfaces.
- No more shell-resolution/PowerShell-wrapper edge cases (exit-code truthiness,
  UTF-8 chunk buffering across code pages, temp-file lifecycle) to maintain or test.
- Smaller packaged surface (`plugin/**` no longer shipped) and a smaller, engine-
  neutral bundled skill.

**Harder:**

- A user who wants crontick to run an arbitrary shell command or binary directly (the
  old `script`/`exec` use case) must front it with a prompt engine (or wait for a
  future action kind); there is no direct replacement in this release.
- Existing job JSON files using `kind: "script"`/`kind: "exec"` will fail validation
  on next load/update and must be migrated by hand to a `prompt` action (or to a
  prompt engine wrapping the same command) -- there is no automatic migration.
- Session-ID capture is temporarily less capable for users who were relying on the
  Copilot-specific resume-hint pattern; a fixed `--session-id` or the generic forms
  are the interim options until the Claude Code adapter work lands.

**Impossible:**

- Reintroducing `script`/`exec` without a fresh sign-off per AGENTS.md rule 8 (this
  ADR is that rule's removal record for both kinds).

## Revisit when

- A concrete need emerges for direct shell/command execution alongside prompt jobs
  (e.g. a "run this exact binary" use case that no prompt engine can reasonably
  front) -- at that point, reintroducing a command-execution action kind needs
  explicit sign-off explaining why this ADR's rationale no longer applies.
- The Claude Code session adapter work begins -- `extractSessionId()` and the
  generic capture model here are expected to be redesigned, not extended, at that
  point.

## Related

- [ADR 0016](0016-detached-children-cross-platform.md) -- unaffected: detached-spawn
  behavior for `exec`/`prompt` actions is unchanged; only the `script`-specific
  PowerShell exception (ADR 0020) loses its trigger.
- [ADR 0018](0018-exec-dash-dash-args.md) -- superseded (the `exec` kind it describes
  is removed).
- [ADR 0019](0019-arg-flag-primary-for-exec-and-prompt-args.md) -- partially
  superseded (its `--exec` guidance is moot; its `--prompt`/`--prompt-file` guidance
  stands).
- [ADR 0020](0020-no-detach-powershell-script-jobs-windows.md) -- superseded (the
  `script` action kind and its PowerShell wrapper are removed; the generic
  command-basename detached exception remains).
- `docs/specs/003-execution.md`, `docs/specs/007-prompt-jobs.md` -- full spec update
  is a follow-up docs pass, out of scope for this ADR.
