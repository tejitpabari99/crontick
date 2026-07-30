---
"crontick": patch
---

Clean up legacy internal code and stale docs from the legacy-code-removal-sweep:
- remove the daemon startup sweep for the old OS temp wrapper directory
- remove dead internal metadata (`CLIENT_METHODS`) and prune internal-only exports
- clean stale README, CLI, spec, and examples prose left from older behavior
- keep supported `CRONTICK_HOME`-managed temp-wrapper behavior and validation coverage intact
- confirm this is an internal cleanup only; `src/index.ts` and the public API surface are unchanged
