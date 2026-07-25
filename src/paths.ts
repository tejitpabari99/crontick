import envPaths from 'env-paths';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

function root(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['CRONTICK_HOME'];
  if (override) return override;
  // env-paths v3: data dir on windows = %LOCALAPPDATA%\crontick
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

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(root(env), 'config.json');
}

export function pidFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(root(env), 'daemon.pid');
}

export function portFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(root(env), 'daemon.port');
}


export function ensureDirs(env: NodeJS.ProcessEnv = process.env): void {
  for (const dir of [dataDir(env), jobsDir(env), logsDir(env)]) {
    mkdirSync(dir, { recursive: true });
  }
}
