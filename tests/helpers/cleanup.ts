/**
 * Helpers for tests that spawn real daemons: stop the process, wait for it to
 * actually exit, then remove its data dir (retrying, because a daemon that is
 * still shutting down can recreate files under it).
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, type ChildProcess } from 'node:child_process';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Live descendants of `pid` (POSIX). The daemon entry re-execs itself on Node < 24 and does not forward signals. */
function descendants(pid: number): number[] {
  if (process.platform === 'win32') return [];
  try {
    const kids = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf-8' })
      .split('\n').map((l) => parseInt(l, 10)).filter((n) => n > 1);
    return kids.flatMap((k) => [k, ...descendants(k)]);
  } catch { return []; }
}

/** SIGTERM, then SIGKILL after `graceMs`; resolves once the process has exited. */
export async function stopProc(proc: ChildProcess | undefined, graceMs = 5_000): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const kids = proc.pid ? descendants(proc.pid) : [];
  const exited = new Promise<void>((res) => proc.once('exit', () => res()));
  try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  const timedOut = await Promise.race([exited.then(() => false), sleep(graceMs).then(() => true)]);
  if (timedOut) {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    await Promise.race([exited, sleep(2_000)]);
  }
  for (const k of kids) { try { process.kill(k, 'SIGTERM'); } catch { /* gone */ } }
  const deadline = Date.now() + 3_000;
  while (kids.some(alive) && Date.now() < deadline) await sleep(50);
  for (const k of kids.filter(alive)) { try { process.kill(k, 'SIGKILL'); } catch { /* gone */ } }
}

/** Kills whatever daemon wrote `<dir>/daemon.pid` (covers daemons we did not spawn directly). */
export async function killDaemonInHome(dir: string): Promise<void> {
  const pidFile = join(dir, 'daemon.pid');
  if (!existsSync(pidFile)) return;
  const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  if (!(pid > 1) || !alive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + 3_000;
  while (alive(pid) && Date.now() < deadline) await sleep(50);
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

export function removeDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
}

/** Full teardown for one daemon fixture: stop process, kill by pid file, remove dir. */
export async function teardownDaemon(proc: ChildProcess | undefined, dir: string | undefined): Promise<void> {
  await stopProc(proc);
  if (dir) {
    await killDaemonInHome(dir);
    removeDir(dir);
  }
}
