#!/usr/bin/env node
/**
 * Test-artifact cleanup: kills leaked crontick test daemons (and their children)
 * and removes leftover `crontick-*` temp dirs.
 *
 * Safety model: a process is only ever killed when it is provably tied to one of
 * the *target directories* (all under the OS temp dir, all named `crontick-*`):
 * its CRONTICK_HOME env var, its working directory, or one of its argv entries
 * lives inside a target. A user's real daemon (data dir outside the OS temp dir)
 * never matches. This file is shared by the vitest teardown
 * (tests/helpers/tmp-isolation.ts) and `npm run clean:test`.
 */
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEMP_PREFIX = 'crontick-';

function isUnder(candidate, dir) {
  if (!candidate) return false;
  const c = resolve(candidate);
  return c === dir || c.startsWith(dir + sep);
}

function real(p) {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/** Lists `crontick-*` entries directly under the OS temp dir. */
export function listTempTargets(tmp = real(tmpdir())) {
  let names = [];
  try { names = readdirSync(tmp); } catch { return []; }
  return names.filter((n) => n.startsWith(TEMP_PREFIX)).map((n) => join(tmp, n));
}

function protectedPids() {
  const pids = new Set([process.pid]);
  if (process.platform === 'linux') {
    let pid = process.ppid;
    while (pid > 1 && !pids.has(pid)) {
      pids.add(pid);
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
        pid = parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1], 10);
      } catch { break; }
    }
  } else {
    pids.add(process.ppid);
  }
  return pids;
}

function readProcFile(pid, name) {
  try { return readFileSync(`/proc/${pid}/${name}`, 'utf-8'); } catch { return ''; }
}

/** Walks each target (2 levels) for daemon.pid files; returns the pids found. */
function pidFilePids(targets) {
  const out = new Set();
  for (const t of targets) {
    for (const dir of [t, ...safeSubdirs(t)]) {
      try {
        const pid = parseInt(readFileSync(join(dir, 'daemon.pid'), 'utf-8').trim(), 10);
        if (pid > 1) out.add(pid);
      } catch { /* none */ }
    }
  }
  return out;
}

function safeSubdirs(dir) {
  try {
    return readdirSync(dir).map((n) => join(dir, n)).filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
  } catch { return []; }
}

/** Pids of live processes tied to any of `targets`. */
export function findLeakedPids(targets) {
  const dirs = targets.map(real);
  const skip = protectedPids();
  const found = new Set();
  if (process.platform === 'linux') {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const pid = parseInt(name, 10);
      if (skip.has(pid)) continue;
      const environ = readProcFile(pid, 'environ').split('\0');
      const home = environ.find((e) => e.startsWith('CRONTICK_HOME='))?.slice('CRONTICK_HOME='.length);
      let cwd = '';
      try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* gone or not ours */ }
      const argv = readProcFile(pid, 'cmdline').split('\0');
      if (dirs.some((d) => isUnder(home, d) || isUnder(cwd, d) || argv.some((a) => isUnder(a, d)))) found.add(pid);
    }
  }
  for (const pid of pidFilePids(dirs)) {
    if (skip.has(pid) || !isAlive(pid)) continue;
    // On Linux the /proc scan above is authoritative; a bare pid file could be a reused pid.
    if (process.platform === 'linux' && !/daemon|crontick/.test(readProcFile(pid, 'cmdline'))) continue;
    found.add(pid);
  }
  return [...found].filter(isAlive);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function killPids(pids) {
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && pids.some(isAlive)) await sleep(50);
  for (const pid of pids.filter(isAlive)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(50);
}

/**
 * Kills leaked processes tied to `targets`, then removes the targets
 * (unless `remove: false`, used for the repo-local `.crontick` scratch dir).
 * Repeats once because a dying daemon can recreate files after the first rm.
 * Returns what is still left (empty arrays mean a clean result).
 */
export async function cleanTargets(targets, { remove = true } = {}) {
  for (let pass = 0; pass < 3; pass++) {
    const pids = findLeakedPids(targets);
    if (pids.length) await killPids(pids);
    if (remove) for (const t of targets) rmSync(t, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (!pids.length) break;
  }
  return { pids: findLeakedPids(targets), dirs: remove ? targets.filter((t) => existsSync(t)) : [] };
}

/** Manual entry point: clean every `crontick-*` dir in the OS temp dir. */
export async function cleanAllTestArtifacts(tmp = real(tmpdir())) {
  return cleanTargets(listTempTargets(tmp));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const before = listTempTargets();
  const result = await cleanTargets(before);
  console.log(`clean:test removed ${before.length - result.dirs.length} temp dir(s) under ${real(tmpdir())}`);
  if (result.pids.length || result.dirs.length) {
    console.error(`clean:test: LEAKS REMAIN pids=[${result.pids}] dirs=[${result.dirs}]`);
    process.exit(1);
  }
}
