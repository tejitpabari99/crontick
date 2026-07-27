# 0020: Do not detach pwsh/powershell.exe script jobs on Windows

- Status: Accepted
- Date: 2026-07-27

## Context

ADR 0016 made every spawned job process detached (`detached: true, windowsHide: true`),
unconditionally and identically on POSIX and Windows, so that a daemon restart or crash
never terminates in-flight job work as a side effect on either platform.

Testing `script` jobs on Windows whose resolved shell is PowerShell (`shell: "auto"`
resolves to `pwsh`, or an explicit `shell: "pwsh"`/`"powershell"`) surfaced a real
regression this exposed: the job's output was always empty, on every run, regardless of
what the script printed.

The root cause is a Windows-specific interaction, not a crontick bug in the redaction or
capture path. Node's `detached: true` maps to the Win32 `DETACHED_PROCESS` creation flag
(see `libuv`'s `src/win/process.c`, and the discussion in nodejs/node#51018). A process
created with `DETACHED_PROCESS` has no console at all. PowerShell's own host requires an
attached console to initialize, and without one it never reaches the point of writing to
its stdout/stderr handles -- confirmed empirically with both pipe-redirected and
file-redirected stdio, both come back completely empty. `cmd.exe` and `node.exe` are
unaffected by the same `detached: true` spawn; `windowsHide` was checked independently
and is not the cause.

Silently losing 100% of a script job's output on Windows whenever the shell is
PowerShell is worse than the problem ADR 0016 solved (surviving daemon restarts), and it
is not acceptable to ship on a first release.

## Decision

`Runner.spawn()` (`src/daemon/runner.ts`) sets `detached: !isWindowsPowerShellHost`,
where `isWindowsPowerShellHost` is true only when `platform() === 'win32'` and the
resolved command's basename (case-insensitive, `.exe` suffix optional) is `pwsh` or
`powershell` (`isPowerShellHostCommand()`). Every other command, on every platform --
including `cmd.exe`-hosted script jobs on Windows, and every `exec`/`prompt` action
regardless of the target binary -- keeps `detached: true` exactly as ADR 0016
established. A diagnostic log line
(`'detached disabled for pwsh/powershell.exe on Windows (output-capture trade-off, see runner.ts)'`)
is appended to the run's captured output whenever the exception applies, so the
trade-off is visible in the run's own logs, not just in source comments.

This is a deliberate, narrow exception to ADR 0016, not a reversal of it: output
capture is chosen over daemon-restart survival for this one command/platform
combination, because a job whose output is unconditionally empty is a worse outcome
than a job that does not outlive a Windows daemon restart.

## Alternatives considered

**Keep `detached: true` unconditionally (ADR 0016's original scope) and accept empty
output for PowerShell script jobs on Windows.** Rejected: an unconditionally empty
`logs` output for the single most common `script`-job shell on Windows (the
`shell: "auto"` default) is a silent, total data-loss bug, not a documentable
limitation -- it fails the README's own first example
(`crontick new hello --script "echo hello"` on Windows).

**Allocate a hidden console for the detached PowerShell child (e.g.
`CREATE_NEW_CONSOLE` instead of `DETACHED_PROCESS`) to keep both detachment and
output.** Rejected: `child_process.spawn`'s Windows creation-flag selection is
internal to Node/libuv and not exposed as a spawn option; there is no supported way
to request "detached but with a console" through Node's public `spawn()` API, and
forking a lower-level Windows process-creation call ourselves would reintroduce
exactly the kind of native platform code `child_process.spawn` exists to avoid.

**Only ever resolve `shell: "auto"` to `cmd.exe` on Windows, avoiding PowerShell as
the default entirely.** Rejected: PowerShell is the modern, more capable default
shell on current Windows and is already documented and tested as the `shell: "auto"`
resolution; changing the default shell to sidestep a spawn-flag limitation would be a
much larger, more visible behavior change than accepting a narrow exception to one
spawn option for that specific shell.

**Wrap PowerShell script jobs in an intermediate `cmd.exe` or a launcher script that
itself can be detached.** Rejected as unnecessary complexity: it adds an extra
process hop, an extra place output could be lost or delayed, and does not remove the
underlying console requirement -- the wrapped PowerShell process would still need a
console to produce output, so the wrapper would just relocate the same problem one
level down.

## Consequences

**Easier:**

- `script` jobs using the default (`shell: "auto"`) or an explicit PowerShell shell
  on Windows produce their output reliably, matching every other job kind and every
  other shell.
- The trade-off is visible per-run (the diagnostic log line), not just documented in
  source comments or an ADR a user is unlikely to read before debugging a specific
  run.

**Harder:**

- A PowerShell script job's child process does NOT survive the daemon being killed
  via Ctrl+C propagated through a shared console on Windows, unlike every other job
  kind/shell combination on every platform (which all still keep ADR 0016's
  detached guarantee). An abrupt crash or `kill -9`-equivalent of the daemon still
  leaves the PowerShell child running, since Windows does not cascade-kill
  independently spawned processes on its own -- only the interactive Ctrl+C-through-
  console path is affected.
- The exception is keyed off the resolved command's basename, so a job that invokes
  PowerShell indirectly (e.g. through a wrapper binary that itself launches
  `powershell.exe`) is not detected and keeps the unconditional-detach behavior
  (and, with it, the empty-output symptom this decision fixes for the direct case).

**Impossible:**

- A single spawn configuration that gives every Windows shell simultaneously full
  output capture and full survival of the daemon's death. For PowerShell script jobs
  on Windows specifically, one of the two must be chosen; this decision chooses
  output capture.

## Revisit when

- Node/libuv exposes a way to request a console-attached detached process on
  Windows (tracked upstream at nodejs/node#51018), which would let PowerShell script
  jobs regain the same survival guarantee as every other job kind without losing
  output.
