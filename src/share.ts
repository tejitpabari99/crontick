/** Pure helpers for `share export` / `share import`. */
import { resolve } from 'node:path';

/**
 * Final export path: the given name is kept unchanged when it already ends in
 * `.json` (case-insensitive), else `.json` is appended (`try_me.txt` becomes
 * `try_me.txt.json`, `backup` becomes `backup.json`). Relative paths resolve
 * against `cwd`.
 */
export function resolveExportPath(out: string, cwd: string): string {
  return resolve(cwd, /\.json$/i.test(out) ? out : `${out}.json`);
}
