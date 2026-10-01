---
"crontick": minor
---

Claude runs now trim the engine stream as it arrives: only the final `result` event and the full stderr are kept (no assistant text segments, no stderr cap, no line-size limit). `RunOutput.output` and the `run_outputs.output`/`truncated` columns are removed. `transcriptPath` honors `CLAUDE_CONFIG_DIR`, is available while the run is in progress, and prefers the path reported by Claude's SessionEnd hook once the run ends.
