// Per-job log file sink: mirrors a run's engine output AND crontick-side
// lifecycle events to <logDir>/<jobGuid>.log, in addition to the SQLite
// run-log storage. All writes are best-effort and never block or fail a run
// (a missing directory or a failed write is swallowed, at most one debug log
// is emitted). The factory is injectable so the runner and tests can supply a
// fake sink without touching real disk. See docs/implementation/executors.md.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { logsDir } from '../paths.js';
import { nullLogger, type Logger } from '../logger.js';

/** A per-job append-only log target. `write` is best-effort and never throws. */
export interface JobLogFile {
  write(text: string): void;
}

/** No-op sink used when file logging is disabled or the target is unavailable. */
export const nullJobLogFile: JobLogFile = { write() {} };

/** Opens a per-job log target. Injected into the Runner; overridable in tests. */
export interface JobLogFileFactory {
  open(jobId: string): JobLogFile;
}

/** No-op factory (used by tests that don't exercise file logging). */
export const nullJobLogFileFactory: JobLogFileFactory = { open: () => nullJobLogFile };

/** Strips anything that isn't filename-safe so a job id can never escape the log dir. */
function safeLogFileName(jobId: string): string {
  const safe = jobId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe || 'job'}.log`;
}

/**
 * Real filesystem-backed factory. Config (`logging.fileEnabled`/`logging.dir`)
 * is resolved once per `open()` — i.e. per run — mirroring the per-run re-read
 * of `retention.maxOutputBytesPerRun` in runner.ts, so a `crontick daemon
 * reload` or config edit is picked up by new runs without a full restart and
 * there is no in-memory cache to go stale.
 */
export function createJobLogFileFactory(logger: Logger = nullLogger): JobLogFileFactory {
  const log = logger.child('job-log-file');
  return {
    open(jobId: string): JobLogFile {
      let fileEnabled = true;
      let dir: string;
      try {
        const logging = loadConfig().logging;
        fileEnabled = logging.fileEnabled;
        dir = logging.dir ?? logsDir();
      } catch {
        // Config load failure must not disable observability silently for the
        // wrong reason — fall back to the default location with logging on.
        dir = logsDir();
      }
      if (!fileEnabled) return nullJobLogFile;

      let filePath: string;
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        filePath = join(dir, safeLogFileName(jobId));
      } catch (err) {
        log.debug('Per-job log directory unavailable; skipping file logging', { jobId, dir, error: String(err) });
        return nullJobLogFile;
      }

      let warned = false;
      return {
        write(text: string): void {
          if (text.length === 0) return;
          try {
            appendFileSync(filePath, text, { encoding: 'utf-8', mode: 0o600 });
          } catch (err) {
            // Best-effort: never let a log-file write break a run. Emit one
            // debug line per run so a persistent problem is diagnosable.
            if (!warned) {
              warned = true;
              log.debug('Per-job log file write failed; continuing (best-effort)', { jobId, filePath, error: String(err) });
            }
          }
        },
      };
    },
  };
}
