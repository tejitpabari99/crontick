// Process-tree termination for job children. Engines (Claude, shell shims) spawn
// their own children, so signalling only the direct child can leave the run's
// stdio pipes open and the run "running" forever. Injectable so tests never
// signal real process groups.
import { spawn, type ChildProcess } from 'node:child_process';
import { platform } from 'node:os';

/** Kills a child and (best effort) everything it spawned. `force` escalates to an uncatchable kill. */
export type TreeKiller = (child: Pick<ChildProcess, 'pid' | 'kill' | 'exitCode' | 'signalCode'>, force: boolean) => void;

/**
 * Default killer.
 * - Windows: `taskkill /PID <pid> /T /F` (tree, forced; Windows has no graceful signal for detached console-less children).
 * - POSIX: children are spawned `detached`, so each leads its own process group; signal the whole group (`-pid`).
 * Falls back to `child.kill()` when the group/tree kill is unavailable.
 */
export const killProcessTree: TreeKiller = (child, force) => {
  if (child.exitCode !== null && child.exitCode !== undefined) return;
  if (child.signalCode !== null && child.signalCode !== undefined) return;
  const pid = child.pid;
  if (pid !== undefined && pid > 0) {
    try {
      if (platform() === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
        killer.unref();
        return;
      }
      process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
      return;
    } catch {
      // fall through to the direct kill
    }
  }
  try {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // already gone
  }
};
