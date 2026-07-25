import { rmSync } from 'node:fs';
import { dataDir } from './paths.js';
import { CrontickError } from './errors.js';
import { readLiveDaemonPid } from './daemon/lifecycle.js';

export interface UninstallOptions {
  purge?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface UninstallResult {
  ok: true;
  purged: boolean;
  dataDir: string;
  message: string;
}

export async function uninstall(options: UninstallOptions = {}): Promise<UninstallResult> {
  const env = { ...process.env, ...(options.env ?? {}) };
  const dir = dataDir(env);

  if (!options.purge) {
    return {
      ok: true,
      purged: false,
      dataDir: dir,
      message: 'Data directory preserved. Run `crontick uninstall --purge` to also delete it.',
    };
  }

  const livePid = readLiveDaemonPid(env);
  if (livePid !== undefined) {
    throw new CrontickError(
      'DAEMON_RUNNING',
      `Cannot purge crontick data at ${dir}: daemon is still running (pid ${livePid}). Attempted uninstall --purge. Stop it first with: crontick daemon stop`,
      { dataDir: dir, pid: livePid, action: 'crontick daemon stop' },
    );
  }

  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    throw new CrontickError(
      'UNINSTALL_PURGE_FAILED',
      `Failed to delete crontick data at ${dir}: ${err instanceof Error ? err.message : String(err)}. Check file permissions or close programs using files under that directory, then retry: crontick uninstall --purge`,
      { dataDir: dir },
    );
  }

  return {
    ok: true,
    purged: true,
    dataDir: dir,
    message: `Data directory deleted: ${dir}`,
  };
}
