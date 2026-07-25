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
