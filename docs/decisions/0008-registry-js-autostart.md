# 0008: Adopt Windows Registry autostart via registry-js

- Status: Superseded by ADR-0009
- Date: 2026-07-18

## Context

For the daemon to fire scheduled jobs reliably, it must be running when jobs are due.
On Windows, the most common mechanism for starting a user-mode process at login is
adding an entry to `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. The initial
implementation in 0.1.0 used `child_process.execSync('reg.exe ADD ...')` which was
fragile (parsing locale-dependent output, quoting issues).

## Decision

Replace `reg.exe` shell-outs with `registry-js`, a native Node.js addon providing typed
access to the Windows Registry. Implemented in commit `f24ae58` ("feat(autostart): use
registry-js instead of reg.exe + gate real-registry tests to CI").

The autostart module (`src/autostart/win32.ts`) wrote a Run key pointing to the daemon
binary, so the daemon would start on user login without manual intervention.

## Alternatives considered

**`reg.exe` shell-out.** The original approach. Rejected due to locale-dependent output
parsing, quoting edge cases, and inability to handle errors structurally.

**Windows Task Scheduler (schtasks).** More powerful but adds complexity (XML task
definitions, COM interop) for what is a simple "run at login" use case.

**No autostart.** Users manually run `crontick daemon start`. Simpler but means jobs
miss their scheduled time if the user forgets.

## Consequences

**Easier:**

- Daemon starts automatically on Windows login.
- Typed API (`registry-js`) eliminated shell-quoting bugs.

**Harder:**

- `registry-js` is a native addon requiring node-gyp compilation at install time. This
  broke installs in environments without a C++ toolchain (corporate lockdown, CI without
  build tools).
- Platform-specific code path that only Windows exercised; macOS/Linux had different
  (less tested) autostart mechanisms.
- Users were surprised by a background process appearing without explicit opt-in.

**Impossible:**

- Clean `npm install -g` on Windows without Visual Studio Build Tools or windows-build-
  tools.

## Revisit when

This decision has been superseded -- see ADR-0009.
