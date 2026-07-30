/**
 * Data directory path resolution. All crontick state (jobs, runs, config, logs,
 * transient script wrappers) lives under a single root directory.
 *
 * Precedence: CRONTICK_HOME env var > platform default via env-paths.
 * Platform defaults: Windows %LOCALAPPDATA%\crontick, macOS ~/Library/Application Support/crontick,
 * Linux ~/.local/share/crontick.
 */
import envPaths from 'env-paths';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

function root(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['CRONTICK_HOME'];
  if (override) return override;
  return envPaths('crontick', { suffix: '' }).data;
}

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return root(env);
}

export function jobsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(root(env), 'jobs');
}

export function runsDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(root(env), 'runs.db');
}

export function logsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(root(env), 'logs');
}

function tempDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(root(env), 'tmp');
}

export function tempScriptsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(tempDir(env), 'scripts');
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(root(env), 'config.json');
}

export function pidFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(root(env), 'daemon.pid');
}

export function portFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(root(env), 'daemon.port');
}


// Owner-only (rwx------): job/prompt definitions on disk can contain inline
// scripts and prompt text, so directories default to a private mode rather
// than the umask-dependent default. mode is a no-op on Windows (fs simply
// ignores it there rather than throwing), so this is safe cross-platform.
const PRIVATE_DIR_MODE = 0o700;

export function ensureDirs(env: NodeJS.ProcessEnv = process.env): void {
  for (const dir of [dataDir(env), jobsDir(env), logsDir(env), tempScriptsDir(env)]) {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  }
}
