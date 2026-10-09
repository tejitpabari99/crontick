---
"crontick": minor
---

Add opt-in login autostart: `crontick autostart enable|disable|status` (Linux `systemd --user`; other platforms report `supported: false`), client methods `autostartEnable`/`autostartDisable`/`autostartStatus`, the read-only MCP tool `crontick_autostart_status` (enable/disable are deliberately not exposed over MCP), new `AUTOSTART_*` error codes and exported autostart types. New `crontick daemon start --home <dir>`; with `CRONTICK_SUPERVISED=1` a daemon start that finds one already running exits 0. `daemon start` still never registers anything. A relative `CRONTICK_HOME`/`--home` is stored as an absolute path, and a daemon killed by a signal under the Node <24 sqlite shim now exits non-zero so `Restart=on-failure` restarts it. Without `loginctl enable-linger`, jobs pause while fully logged out; run `crontick autostart disable` before uninstalling. See ADR 0034.
