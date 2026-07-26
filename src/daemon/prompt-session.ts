// Session ID extraction from prompt engine output (last 128 KB of combined stdout/stderr).
// Used by the runner to persist a session ID for subsequent reuseSession runs.

/** Extract a session ID from engine output using known patterns. */
export function extractSessionId(text: string): string | undefined {
  const patterns = [
    /(?:session\s*id|session-id|sessionId)\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._:-]{7,})/i,
    /--session-id\s+([A-Za-z0-9][A-Za-z0-9._:-]{7,})/i,
    /(?:started|created|resum(?:e|ed|ing))\s+(?:copilot\s+)?session\s+([A-Za-z0-9][A-Za-z0-9._:-]{7,})/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return undefined;
}
