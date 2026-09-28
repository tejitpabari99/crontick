import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Locate Claude's transcript for a session in an absolute working directory. */
export function resolveTranscriptPath(cwd: string, sessionId: string, homeDir = homedir()): string {
  const encodedCwd = resolve(cwd).replaceAll('/', '-').replaceAll('.', '-');
  return join(homeDir, '.claude', 'projects', encodedCwd, `${sessionId}.jsonl`);
}
