import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { AutostartDeps } from './types.js';

/** Real OS wiring (exec, fs, platform) for autostart; injectable via client options in tests. */
export function defaultAutostartDeps(env: NodeJS.ProcessEnv): AutostartDeps {
  return {
    platform: process.platform,
    env,
    homedir: homedir(),
    exec: (file, args) => new Promise((done) => {
      execFile(file, args, { encoding: 'utf-8', timeout: 30_000 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0;
        done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? (err ? err.message : '')) });
      });
    }),
    fs: {
      readFile: (p, enc) => readFile(p, enc),
      writeFile: (p, d, o) => writeFile(p, d, o),
      mkdir: (p, o) => mkdir(p, o),
      rm: (p, o) => rm(p, o),
      access: (p) => access(p),
    },
  };
}
