# 0009: Remove autostart registration -- demand-start only

- Status: Accepted
- Date: 2026-07-25

## Context

ADR-0008 introduced automatic daemon registration at OS login via `registry-js` on
Windows (with equivalent mechanisms on macOS and Linux). In practice this caused:

1. **Install failures.** `registry-js` is a native addon requiring node-gyp and a C++
   toolchain. Corporate environments and CI containers often lack these.
2. **Surprising behavior.** Users reported an unexpected background process appearing
   after install or login.
3. **Platform fragmentation.** Three platform-specific autostart modules
   (`src/autostart/win32.ts`, `darwin.ts`, `linux.ts`) with limited test coverage.
4. **Dependency weight.** `registry-js` pulled in node-gyp build infra for a feature
   most users did not need.

## Decision

Remove all autostart registration surfaces:

- Delete `src/autostart/` (win32, darwin, linux, manual, index modules).
- Remove `registry-js` from dependencies.
- Remove the `plugin/uninstall.mjs` script that cleaned up registry entries.
- Replace autostart with demand-start: every client operation that needs the daemon
  calls `ensureDaemon()` which starts it transparently if not already running.
- Retain `crontick daemon start` for users who want explicit manual control.

This is a **BREAKING** change tracked in `.changeset/purple-crabs-prompt.md` (major
version bump).

Implemented in commit `e592b95` ("refactor!: remove autostart surfaces") and verified
by `tests/autostart-removal.test.ts` which asserts the old modules no longer exist.

## Alternatives considered

**Keep autostart as opt-in (`crontick install-autostart`).** Preserves the capability
for users who want it. Rejected for now because the demand-start model is sufficient
and avoids the native-addon tax. May revisit later.

**Replace native addon with shell commands.** Go back to `reg.exe` / `launchctl` /
`systemctl --user`. Still platform-specific, still surprising, still fragile.

**Keep autostart but vendor a prebuilt binary of registry-js.** Avoids node-gyp but
adds a prebuilt binary to the npm tarball, complicating provenance and multi-arch
support.

## Consequences

**Easier:**

- `npm install -g crontick` works on every platform without a C++ toolchain.
- No surprising background processes -- the daemon only runs when needed.
- Smaller dependency tree and published tarball.
- Test matrix simplified (no platform-specific autostart tests).

**Harder:**

- Users who want the daemon always running must arrange their own keep-alive (systemd
  user unit, launchd plist, Task Scheduler, etc.).
- Jobs scheduled for times when no client triggers the daemon will not fire until the
  next client interaction.

**Impossible:**

- Automatic daemon startup at login without user-configured OS integration (intentional
  trade-off for install simplicity).

## Revisit when

- Demand-start proves insufficient and users frequently miss scheduled ticks.
- A cross-platform, pure-JS mechanism for login-time process registration becomes
  available (unlikely in the near term).
- An optional `crontick service install` command is implemented that generates platform-
  specific configs without baking them into the default install.
