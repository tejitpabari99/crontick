// Session ID extraction from prompt engine output (last 128 KB of combined stdout/stderr).
// Used by the runner to persist a session ID for subsequent reuseSession runs.
//
// This is a minimal, engine-agnostic implementation: it matches only generic
// `--session-id=<id>` / `--session-id <id>` flags and generic "session id: X"
// / "started/created/resumed session X" phrasing that any engine's output
// might contain. A previous version also matched the Copilot CLI's
// engine-specific `--resume=<uuid>` stats-footer form; that pattern was
// removed along with the rest of the Copilot-specific integration (see
// docs/decisions/0028-prompt-only-jobs.md) -- a future engine-adapter design
// is expected to replace this generic regex-based capture entirely.

/**
 * Extract a session ID from engine output using known generic patterns.
 * Patterns are ordered most-specific/most-reliable first. The `[stderr] `
 * prefix crontick prepends is tolerated because each pattern matches
 * anywhere in the text.
 */
export function extractSessionId(text: string): string | undefined {
  const patterns = [
    /--session-id[=\s]+([A-Za-z0-9][A-Za-z0-9._:-]{7,})/i,
    /(?:session\s*id|session-id|sessionId)\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._:-]{7,})/i,
    /(?:started|created|resum(?:e|ed|ing))\s+session\s+([A-Za-z0-9][A-Za-z0-9._:-]{7,})/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return undefined;
}
