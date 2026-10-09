---
"crontick": minor
---

Add `daemon.port` to `config.json` (integer 0..65535; unset keeps the 47615 default with random-port fallback). An explicit port that is already in use now fails daemon start with `DAEMON_PORT_IN_USE` instead of falling back; `0` means OS-assigned. The port is read at startup only (restart required). Dashboard is scaled to ~80% and the header now shows only `v<version> · pid <pid>` plus a red error badge when the daemon is unreachable.

BREAKING: the `CRONTICK_DAEMON_PORT` environment variable is removed and no longer read; set `daemon.port` in `config.json` instead.
