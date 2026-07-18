import envPaths from 'env-paths';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

function root(): string {
  const override = process.env['CRONTICK_HOME'];
  if (override) return override;
  // env-paths v3: data dir on windows = %LOCALAPPDATA%\crontick
  return envPaths('crontick', { suffix: '' }).data;
}

export function dataDir(): string {
  return root();
}

export function jobsDir(): string {
  return join(root(), 'jobs');
}

export function runsDbPath(): string {
  return join(root(), 'runs.db');
}

export function logsDir(): string {
  return join(root(), 'logs');
}

export function configPath(): string {
  return join(root(), 'config.json');
}

export function pidFilePath(): string {
  return join(root(), 'daemon.pid');
}

export function portFilePath(): string {
  return join(root(), 'daemon.port');
}

export function autostartDir(): string {
  return join(root(), 'autostart');
}

export function ensureDirs(): void {
  for (const dir of [dataDir(), jobsDir(), logsDir()]) {
    mkdirSync(dir, { recursive: true });
  }
}
