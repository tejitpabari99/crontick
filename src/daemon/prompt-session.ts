// Session ID extraction from prompt engine output (last 128 KB of combined stdout/stderr).
// Used by the runner to persist a session ID for subsequent reuseSession runs.

/**
 * Extract a session ID from engine output using known patterns.
 *
 * Patterns are ordered most-specific/most-reliable first. The Copilot CLI
 * (verified against v1.0.78-2) emits its session id ONLY in the stats footer
 * on stderr as a resume hint, e.g.:
 *
 *     Resume     copilot --resume=b4823c07-1617-489e-9fe4-820a42ba8677
 *
 * so the `--resume=<id>` form must be matched (the earlier patterns did not
 * cover it, which caused reuseSession jobs to fail with SESSION_ID_NOT_FOUND
 * even though the id was present in the transcript). The `[stderr] ` prefix
 * crontick prepends and surrounding stats lines (AI Credits / Tokens) are
 * tolerated because each pattern matches anywhere in the text. Both `=` and
 * whitespace separators are accepted for `--resume`/`--session-id`.
 */
export function extractSessionId(text: string): string | undefined {
  const patterns = [
    /--resume[=\s]+([A-Za-z0-9][A-Za-z0-9._:-]{7,})/i,
    /--session-id[=\s]+([A-Za-z0-9][A-Za-z0-9._:-]{7,})/i,
    /(?:session\s*id|session-id|sessionId)\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._:-]{7,})/i,
    /(?:started|created|resum(?:e|ed|ing))\s+(?:copilot\s+)?session\s+([A-Za-z0-9][A-Za-z0-9._:-]{7,})/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return undefined;
}
