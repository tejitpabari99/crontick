import { homedir } from 'node:os';
import { join, resolve, win32 } from 'node:path';

/** Locate Claude's transcript for a session in an absolute working directory. */
export function resolveTranscriptPath(cwd: string, sessionId: string, homeDir = homedir()): string {
  // Windows drive paths must be resolved with win32 even when inspecting an
  // export on another platform. Claude names C:\\Users\\me as C--Users-me.
  const absoluteCwd = win32.isAbsolute(cwd) ? win32.resolve(cwd) : resolve(cwd);
  const encodedCwd = absoluteCwd.replace(/[\\/.:]/g, '-');
  return join(homeDir, '.claude', 'projects', encodedCwd, `${sessionId}.jsonl`);
}
