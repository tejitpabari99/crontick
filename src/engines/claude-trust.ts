/**
 * Claude Code folder trust: reading and (with the user's consent) updating the
 * `projects[<abs path>].hasTrustDialogAccepted` flags in Claude's global config
 * file (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`).
 *
 * Claude treats a folder as trusted when its own entry, or an ancestor's entry,
 * has `hasTrustDialogAccepted: true`. Note `claude -p` itself skips the
 * interactive trust dialog; the persisted flag still governs project-scoped
 * settings/hooks loading, so crontick's check is a guardrail for the owner's
 * intent, not a hard Claude requirement. That is why an unreadable file counts
 * as "not trusted" (the user is asked) rather than being fatal.
 *
 * All filesystem, env and home-directory access is injectable (`TrustDeps`) so
 * tests never touch the real file; `CLAUDE_CONFIG_DIR` redirects it as well.
 */
import {
  chmodSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CrontickError } from '../errors.js';

export interface TrustFs {
  readFileSync(path: string, encoding: 'utf-8'): string;
  writeFileSync(path: string, data: string, options: { encoding: 'utf-8'; mode: number }): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  chmodSync(path: string, mode: number): void;
  statSync(path: string): { mtimeMs: number; size: number; mode: number };
  realpathSync(path: string): string;
}

export interface TrustDeps {
  fs?: TrustFs;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}

const REAL_FS: TrustFs = { readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync, statSync, realpathSync };
const MAX_WRITE_ATTEMPTS = 3;

function resolveDeps(deps: TrustDeps = {}): Required<TrustDeps> {
  return { fs: deps.fs ?? REAL_FS, env: deps.env ?? process.env, homedir: deps.homedir ?? homedir };
}

/** Path of Claude's global config file: `$CLAUDE_CONFIG_DIR/.claude.json` when set, else `~/.claude.json`. */
export function claudeConfigPath(deps?: TrustDeps): string {
  const { env, homedir: home } = resolveDeps(deps);
  const dir = env['CLAUDE_CONFIG_DIR'];
  return dir ? join(dir, '.claude.json') : join(home(), '.claude.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readProjects(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && isRecord(parsed['projects'])) return parsed['projects'];
  } catch {
    // unreadable/non-JSON: treated as "no trusted folders"
  }
  return undefined;
}

/** The folder and every ancestor, nearest first, ending at the filesystem root. */
function withAncestors(path: string): string[] {
  const chain: string[] = [];
  let current = resolve(path);
  for (;;) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) return chain;
    current = parent;
  }
}

/**
 * True when the folder (resolved exactly and through symlinks) or any ancestor
 * has `hasTrustDialogAccepted: true`. A missing, unreadable or non-JSON config
 * file means "not trusted".
 */
export function isFolderTrusted(cwd: string, deps?: TrustDeps): boolean {
  const resolved = resolveDeps(deps);
  let projects: Record<string, unknown> | undefined;
  try {
    projects = readProjects(resolved.fs.readFileSync(claudeConfigPath(deps), 'utf-8'));
  } catch {
    return false;
  }
  if (!projects) return false;
  const candidates = new Set(withAncestors(cwd));
  try {
    for (const path of withAncestors(resolved.fs.realpathSync(cwd))) candidates.add(path);
  } catch {
    // folder may not exist yet; the exact-path chain still applies
  }
  for (const candidate of candidates) {
    const entry = projects[candidate];
    if (isRecord(entry) && entry['hasTrustDialogAccepted'] === true) return true;
  }
  return false;
}

/**
 * Marks `cwd` as trusted in Claude's config, preserving every other key and the
 * rest of the folder's own entry. Aborts without touching the file when it
 * cannot be parsed (`CLAUDE_CONFIG_UNREADABLE`). Claude rewrites this file
 * often, so the write is a read-modify-write guarded by a stat check just
 * before the rename, retried up to 3 times when the file changed underneath us.
 */
export function trustFolder(cwd: string, deps?: TrustDeps): void {
  const { fs } = resolveDeps(deps);
  const configPath = claudeConfigPath(deps);
  let target = resolve(cwd);
  try {
    target = fs.realpathSync(cwd);
  } catch {
    // keep the resolved path
  }

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    let raw = '{}';
    let before: { mtimeMs: number; size: number; mode: number } | undefined;
    try {
      before = fs.statSync(configPath);
      raw = fs.readFileSync(configPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new CrontickError('CLAUDE_CONFIG_UNREADABLE', `Cannot read Claude's config file ${configPath}: ${String(err)}. Nothing was changed.`, { path: configPath });
      }
    }

    let config: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) throw new Error('top-level value is not an object');
      config = parsed;
    } catch (err) {
      throw new CrontickError(
        'CLAUDE_CONFIG_UNREADABLE',
        `Claude's config file ${configPath} is not valid JSON (${String(err)}). Nothing was changed; fix or remove the file, or trust the folder by running claude in it once.`,
        { path: configPath },
      );
    }

    const projects = isRecord(config['projects']) ? { ...config['projects'] } : {};
    const existing = projects[target];
    projects[target] = isRecord(existing)
      ? { ...existing, hasTrustDialogAccepted: true }
      : { allowedTools: [], hasTrustDialogAccepted: true };
    config['projects'] = projects;

    const tmpPath = `${configPath}.${process.pid}.tmp`;
    const mode = before ? before.mode & 0o777 : 0o600;
    fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf-8', mode });
    try {
      fs.chmodSync(tmpPath, mode);
      const after = safeStat(fs, configPath);
      const changed = before
        ? after === undefined || after.mtimeMs !== before.mtimeMs || after.size !== before.size
        : after !== undefined;
      if (changed) {
        fs.unlinkSync(tmpPath);
        if (attempt < MAX_WRITE_ATTEMPTS) continue;
        throw new CrontickError(
          'CLAUDE_CONFIG_BUSY',
          `Claude's config file ${configPath} kept changing while crontick tried to update it. Nothing was changed; try again in a moment.`,
          { path: configPath },
        );
      }
      fs.renameSync(tmpPath, configPath);
      return;
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* temp already gone */ }
      throw err;
    }
  }
}

function safeStat(fs: TrustFs, path: string): { mtimeMs: number; size: number; mode: number } | undefined {
  try {
    return fs.statSync(path);
  } catch {
    return undefined;
  }
}
