# 0018: `--exec` takes command and args verbatim, separated by `--`

- Status: Accepted
- Date: 2026-07-26

## Context

Before this decision, `crontick create --exec '<command>'` accepted a single string and
split it on whitespace to derive `command` and `args` for the job's exec action. This
meant any argument containing a space (a file path with spaces, a JSON string, an argument
with an embedded flag value) could not be expressed correctly through `--exec` -- the
naive split would break it into the wrong number of tokens with no way to escape or quote
around the splitter. The library API and MCP tool were unaffected (they take `command` and
an `args` array directly), so this was specifically a CLI ergonomics gap, and specifically
one that was silently wrong rather than rejected: a job with a broken exec command it just
looked like it had been created successfully.

## Decision

`crontick create`/`update --exec <command> -- <args...>` now takes `<command>` as the
literal executable name/path (never split), and takes every argument after a literal `--`
separator as one array element per CLI argument, with no further parsing --
`buildJobFromCreateOptions({ exec, rawArgs })` (`src/job-input.ts`) assigns `rawArgs`
directly to `action.args`, reusing the same `--` convention already used by prompt-mode
jobs. If no `--`/`rawArgs` is given, `--exec '<command with spaces>'` is still accepted as
a literal single command string (e.g. a shell builtin path), preserved intact rather than
split. `--script` explicitly rejects `rawArgs`/`--` (`"Raw args after --"` error), since a
script action has no separate command/args split to receive them into.

This makes the CLI's `--exec ... -- ...` produce an action identical to what the library
API's `{ command, args: [...] }` form would produce for the same intent -- there is exactly
one exec semantic, expressed two ways.

## Alternatives considered

**Keep whitespace splitting, add a quoting/escaping convention on top.** Rejected: this
adds an entire shell-like quoting dialect to parse and document (its own escape rules, edge
cases, and inevitable mismatches with the user's actual shell's quoting), for a problem `--`
already solves without needing a dialect at all.

**Require `--exec` to always take a single already-shell-quoted string and hand it to a
real shell for parsing (`shell: true`).** Rejected: this reintroduces shell interpretation
(globbing, variable expansion, command chaining via `;`/`&&`) into a code path that spec
003 and the runner deliberately keep shell-free for predictability and to avoid a command-
injection surface when job definitions come from untrusted or programmatic sources (import,
MCP, library API).

**Only fix this via the library/MCP array form; leave the CLI's `--exec` limitation
documented.** Rejected per the explicit v1.0.0 mandate: a first release cannot ship a known,
silently-wrong CLI flag when the fix (reusing the `--` convention already present for
prompt jobs) was a small, consistent addition.

## Consequences

**Easier:**

- An argument containing a space, quote, or shell metacharacter can be expressed correctly
  through the CLI by putting it after `--`, exactly as `args` in the library/MCP API would.
- CLI-built and library/API-built exec jobs are behaviorally identical for the same intent,
  verified directly (`tests/job-input.test.ts`, "produces action output identical to the
  library/MCP args-array form for the same intent").
- Users familiar with the common `command -- arg1 arg2` convention (used by many CLIs, and
  already used by crontick's own prompt-mode jobs) do not have to learn a crontick-specific
  quoting rule.

**Harder:**

- Two real Windows shim behaviors surface as a direct consequence of relying on `--`: npm's
  generated `.ps1` wrapper drops a literal `--` token before the script sees it, and the
  `.cmd` wrapper mangles embedded double quotes. Neither is a crontick defect -- both are
  documented as Windows/npm shim environment notes (use `crontick.cmd` directly for
  `--`-based commands), not as limitations of `--exec` itself.
- A user who does not use `--` still gets old-style single-string behavior (accepted
  verbatim, not split) -- so a pre-existing script that relied on the old splitting-based
  behavior for a multi-word command must be migrated to `-- word1 word2` form; there is no
  automatic detection of which form was intended.

**Impossible:**

- Splitting a single un-delimited string into a command and multiple arguments by any rule
  that reliably preserves embedded spaces. `--` is required precisely because no
  whitespace-based heuristic can distinguish "one argument with a space in it" from "two
  arguments" without an explicit delimiter.

## Revisit when

- A significant number of users report friction with the `--` convention itself (as opposed
  to friction with the npm/Windows shim issues, which are already being addressed
  separately in user-facing docs). Not expected, since `--` is an established convention
  crontick's own prompt-mode jobs already used before this decision.
