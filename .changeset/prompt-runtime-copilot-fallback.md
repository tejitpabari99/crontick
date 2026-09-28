---
"crontick": patch
---

Fix two leftover fallbacks that still defaulted to the removed Copilot engine when a prompt action's engine was unset: the Windows command-line length estimate and the args-only patch runtime validation now fall back to `claude`, the sole remaining built-in engine.
