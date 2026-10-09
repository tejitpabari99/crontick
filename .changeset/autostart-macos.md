---
"crontick": minor
---

`crontick autostart enable|disable|status` now supports macOS via a per-user launchd LaunchAgent (`~/Library/LaunchAgents/dev.crontick.daemon.plist`, `launchctl bootstrap gui/$UID`). Starts at login only, no admin or signing; it appears in System Settings > Login Items as an unsigned "node" item and can be switched off there (status reports it). Launched `node` has no Full Disk Access (TCC) and Claude may report "Not logged in" under launchd (set `CLAUDE_CODE_OAUTH_TOKEN` via engine env config). See ADR 0034.
