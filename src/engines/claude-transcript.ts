import { homedir } from 'node:os';
import { join, resolve, win32 } from 'node:path';

// JobSchema's sessionId is a bare `z.string().min(1)` (no format restriction,
// kept that way deliberately -- see docs/specs). A
// sessionId containing a path separator, a `..` traversal segment, or a NUL
// byte must never be allowed to influence the filesystem path this builds.
// Not currently reachable end-to-end (the resume preflight in runner.ts only
// ever offers a sessionId that already round-tripped through
// hasCompletedClaudeSession()), but this is the one place every caller's path
// gets built, so it's the right place for defense in depth.
const UNSAFE_SESSION_ID = /[/\\]|\.\./;

/** True when a sessionId could escape the intended transcript directory. */
export function isUnsafeSessionId(sessionId: string): boolean {
  // NUL is checked separately (not via regex) to avoid a control-character
  // regex literal (no-control-regex).
  return UNSAFE_SESSION_ID.test(sessionId) || sessionId.includes('\0');
}

// Guaranteed to never name a real transcript (real ids are Claude/crontick
// generated UUIDs) and, unlike the raw sessionId, is safe to join into a path.
const INVALID_SESSION_MARKER = 'crontick-invalid-session-id';

/**
 * Locate Claude's transcript for a session in an absolute working directory.
 *
 * Always returns a path (never throws, never returns undefined) so callers
 * that use "is this defined" to mean "does this adapter do transcript-backed
 * resume at all" (see EngineAdapter.resumeTranscriptPath) keep working. An
 * unsafe sessionId is substituted with a marker that cannot exist on disk, so
 * the caller's own existence check (`transcriptExists`) fails closed and the
 * run is treated as SESSION_NOT_FOUND rather than the unsafe id ever reaching
 * a real filesystem path.
 */
export function resolveTranscriptPath(cwd: string, sessionId: string, homeDir = homedir()): string {
  // Windows drive paths must be resolved with win32 even when inspecting an
  // export on another platform. Claude names C:\\Users\\me as C--Users-me.
  const absoluteCwd = win32.isAbsolute(cwd) ? win32.resolve(cwd) : resolve(cwd);
  const encodedCwd = absoluteCwd.replace(/[\\/.:]/g, '-');
  const safeSessionId = isUnsafeSessionId(sessionId) ? INVALID_SESSION_MARKER : sessionId;
  return join(homeDir, '.claude', 'projects', encodedCwd, `${safeSessionId}.jsonl`);
}
