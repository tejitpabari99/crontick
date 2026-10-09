---
"crontick": minor
---

`crontick autostart enable|disable|status` now supports Windows via a per-user Task Scheduler logon task `\crontick\daemon` (registered from an XML definition with `schtasks.exe`). Starts at logon only, no admin rights, nothing to sign. The task runs `node.exe <cli> daemon start`, a short-lived launcher, so a console window may flash for under a second at logon; the daemon itself is the usual detached process. `autostart status` reports `active` for that launcher task (so `no` is normal while the daemon runs). Visible in `taskschd.msc`; `disable` leaves an empty `\crontick` folder. Security tools: there is no official pre-clearing program, see SECURITY.md for allowlisting. Creating the task as a standard user is unverified. See ADR 0034.
