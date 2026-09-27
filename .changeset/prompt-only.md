---
"crontick": minor
---

**Breaking:** crontick is now prompt-only. The `script` and `exec` job action kinds are removed -- every job's `action.kind` must be `"prompt"`. Existing jobs using `kind: "script"` or `kind: "exec"` will be rejected by validation on next create/update and must be migrated by hand to a prompt action. The `--script`/`--exec`/`--shell` CLI flags, the corresponding MCP validation branches, and all script/exec runner internals (temp-file/shell handling, the PowerShell exit/UTF-8 wrapper) are removed. The Copilot marketplace plugin (`plugin/`) and this repo's Copilot-specific `.github/skills/` are also removed from this branch (preserved on `users/tejitpabari/copilot-init`); the bundled `src/skill/SKILL.md` is now engine-neutral. Session-ID capture (`extractSessionId`) drops the Copilot-specific `--resume=<uuid>` pattern in favor of a minimal generic fallback (`--session-id=<id>`, `session id: <id>`). See ADR 0028 for the full rationale.
