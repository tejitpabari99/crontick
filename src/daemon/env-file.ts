import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Job } from '../schemas/job.js';
import { CrontickError } from '../errors.js';

interface EnvFileAction {
  kind: Job['action']['kind'];
  cwd?: string;
  envFile?: string;
}

export interface EnvFileReadResult {
  path: string;
  vars: Record<string, string>;
}

/**
 * Parse a .env-style file (KEY=VALUE, # comments, quoted values).
 * Returns a record of KEY → VALUE.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

function resolveEnvFilePath(action: EnvFileAction, processCwd: string): string | undefined {
  if (!action.envFile) return undefined;
  return isAbsolute(action.envFile) ? action.envFile : join(action.cwd ?? processCwd, action.envFile);
}

export function readEnvFileForAction(action: EnvFileAction, processCwd = process.cwd()): EnvFileReadResult | undefined {
  const path = resolveEnvFilePath(action, processCwd);
  if (!path) return undefined;

  try {
    return {
      path,
      vars: parseEnvFile(readFileSync(path, 'utf-8')),
    };
  } catch (err) {
    throw new CrontickError(
      'ENV_FILE_ERROR',
      `Failed to load envFile "${path}". Ensure the file exists and is readable.`,
      {
        path,
        actionKind: action.kind,
        cwd: action.cwd ?? processCwd,
        cause: err instanceof Error ? err.message : String(err),
      },
    );
  }
}
