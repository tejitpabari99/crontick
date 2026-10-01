---
"crontick": minor
---

Claude runs now trim the engine stream as it arrives: only the final `result` event and stderr are kept (no assistant text segments, no line-size limit; stderr is capped at 1,000,000 bytes per run with a truncation marker, for every engine). Only Claude (stream-json) runs are trimmed this way; other engines' stdout is plain output under `retention.maxOutputBytesPerRun`, and the runner warns that it has no adapter support. `RunOutput.output` and the `run_outputs.output`/`truncated` columns are removed. `transcriptPath` honors `CLAUDE_CONFIG_DIR`, is available while the run is in progress, and prefers the path reported by Claude's SessionEnd hook once the run ends.
