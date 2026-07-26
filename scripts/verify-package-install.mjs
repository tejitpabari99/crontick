#!/usr/bin/env node
/**
 * Proves the *published* tarball actually works, not just that it contains the
 * right files (that shape-only check is scripts/verify-tarball.mjs). This
 * script:
 *   1. Packs a REAL tarball (not --dry-run).
 *   2. Installs it into a throwaway scratch project (as a real consumer would).
 *   3. Imports the package and exercises its documented public exports.
 *   4. Runs all three bins (crontick, crontick-daemon, crontick-mcp) far enough
 *      to prove they start correctly against the installed artifact.
 *
 * Bins are invoked by resolving the installed package's own `bin` map and
 * running the target file directly with `node` (not via `npx`/shims): npx
 * spawns an extra wrapper process, and killing the wrapper does not kill the
 * grandchild it spawns, which would leak long-running daemon/mcp processes.
 *
 * `crontick-daemon` and `crontick-mcp` are long-running servers with no
 * `--help`/exit-on-flag handling, so "runs" here means: launches without
 * crashing/erroring within a timeout, then is stopped by this script.
 *
 * Run: npm run build && node scripts/verify-package-install.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratchDir = join(root, '.verify-package-scratch');
const scratchHome = join(scratchDir, 'crontick-home');
const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

let tarballPath;

function log(msg) {
  console.log(`[verify-package-install] ${msg}`);
}

function fail(msg) {
  console.error(`\n[verify-package-install] FAILED: ${msg}\n`);
  cleanup();
  process.exit(1);
}

/** Synchronous sleep, used to back off retries against transient Windows file locks. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** rmSync with retries: a just-killed child process's file handles (SQLite/log
 *  files under CRONTICK_HOME) can take the OS a moment to release on Windows,
 *  which otherwise surfaces as a spurious EPERM/EBUSY here. */
function rmWithRetry(path, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      sleepSync(300);
    }
  }
}

function cleanup() {
  rmWithRetry(scratchDir);
  if (tarballPath && existsSync(tarballPath)) rmWithRetry(tarballPath);
}

/**
 * Spawn `cmd` and resolve once it either exits on its own or is killed after
 * surviving `timeoutMs`. Always waits for the real OS-level exit (not just the
 * kill() call returning) so callers can safely touch any files the child had
 * open (important on Windows, where a just-killed process may briefly still
 * hold file handles).
 */
function runWithTimeout(cmd, args, options, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    let survived = false;
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolvePromise({ survived, code, stdout, stderr });
    };

    const timeoutTimer = setTimeout(() => {
      // Still running after timeoutMs with no crash: treat as "started OK",
      // then stop it. crontick-daemon/crontick-mcp never exit on their own.
      survived = true;
      child.kill(isWindows ? undefined : 'SIGTERM');
      // Fallback in case graceful shutdown hangs; the shared 'exit' listener
      // below resolves the promise once the OS confirms the process is gone.
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 3000);
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timeoutTimer);
      finish(code);
    });
    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      stderr += String(err);
      finish(null);
    });
  });
}

/** Resolve `bin` from the just-installed package's own package.json to an absolute file path. */
function resolveInstalledBin(binName) {
  const pkgPath = join(scratchDir, 'node_modules', 'crontick', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const relPath = pkg.bin?.[binName];
  if (!relPath) fail(`Installed package.json has no "${binName}" bin entry`);
  return join(scratchDir, 'node_modules', 'crontick', relPath);
}

async function main() {
  log('Packing real tarball (npm pack)...');
  const packOutput = execFileSync(npmCmd, ['pack', '--json'], { cwd: root, encoding: 'utf-8', shell: isWindows });
  const [packInfo] = JSON.parse(packOutput);
  tarballPath = join(root, packInfo.filename);
  if (!existsSync(tarballPath)) fail(`npm pack reported ${packInfo.filename} but it was not found on disk`);
  log(`Packed ${packInfo.filename}`);

  rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(scratchDir, { recursive: true });
  mkdirSync(scratchHome, { recursive: true });
  writeFileSync(
    join(scratchDir, 'package.json'),
    JSON.stringify({ name: 'crontick-verify-scratch', version: '0.0.0', private: true }, null, 2),
  );

  log('Installing tarball into scratch project...');
  execFileSync(npmCmd, ['install', tarballPath, '--no-audit', '--no-fund', '--no-save'], {
    cwd: scratchDir,
    stdio: 'inherit',
    shell: isWindows,
  });

  log('Importing every documented public export from the installed package...');
  const importCheckPath = join(scratchDir, 'verify-import.mjs');
  writeFileSync(
    importCheckPath,
    `
    import * as crontick from 'crontick';
    const required = [
      'VERSION', 'createClient', 'CrontickClient', 'CrontickError',
      'jobJsonSchema', 'jobJsonSchemaText', 'buildJobFromCreateOptions',
      'ConfigSchema', 'EngineConfigSchema', 'JobSchema', 'ScheduleSchema',
      'SURFACE_CAPABILITIES', 'createLogger',
    ];
    const missing = required.filter((name) => crontick[name] === undefined);
    if (missing.length > 0) {
      console.error('Missing exports from installed package: ' + missing.join(', '));
      process.exit(1);
    }
    if (typeof crontick.VERSION !== 'string' || crontick.VERSION.length === 0) {
      console.error('VERSION export is not a non-empty string');
      process.exit(1);
    }
    // Constructing a client must not throw or perform I/O by itself.
    const client = crontick.createClient();
    if (typeof client.listJobs !== 'function') {
      console.error('createClient() did not return a usable CrontickClient');
      process.exit(1);
    }
    console.log('Import check OK: ' + required.length + ' exports present, VERSION=' + crontick.VERSION);
    `,
  );
  execFileSync(process.execPath, [importCheckPath], { cwd: scratchDir, stdio: 'inherit' });

  log('Running crontick --version...');
  const cliBin = resolveInstalledBin('crontick');
  const versionResult = await runWithTimeout(process.execPath, [cliBin, '--version'], { cwd: scratchDir }, 15000);
  if (versionResult.survived || versionResult.code !== 0) {
    fail(`crontick --version did not exit cleanly (code=${versionResult.code})\n${versionResult.stdout}${versionResult.stderr}`);
  }
  log(`crontick --version -> ${versionResult.stdout.trim()}`);

  log('Running crontick-daemon (isolated CRONTICK_HOME, timeout+kill)...');
  const daemonBin = resolveInstalledBin('crontick-daemon');
  const daemonEnv = { ...process.env, CRONTICK_HOME: join(scratchHome, 'daemon') };
  const daemonResult = await runWithTimeout(process.execPath, [daemonBin], { cwd: scratchDir, env: daemonEnv }, 8000);
  if (!daemonResult.survived) {
    fail(`crontick-daemon exited early (code=${daemonResult.code})\n${daemonResult.stdout}${daemonResult.stderr}`);
  }
  if (!daemonResult.stderr.includes('Daemon ready') && !daemonResult.stderr.includes('API listening')) {
    fail(`crontick-daemon did not report readiness within timeout\n${daemonResult.stdout}${daemonResult.stderr}`);
  }
  log('crontick-daemon started and reported readiness (stopped after timeout)');

  log('Running crontick-mcp (timeout+kill)...');
  const mcpBin = resolveInstalledBin('crontick-mcp');
  const mcpResult = await runWithTimeout(process.execPath, [mcpBin], { cwd: scratchDir }, 5000);
  if (!mcpResult.survived) {
    fail(`crontick-mcp exited early (code=${mcpResult.code})\n${mcpResult.stdout}${mcpResult.stderr}`);
  }
  if (mcpResult.stderr.includes('Fatal')) {
    fail(`crontick-mcp reported a fatal error\n${mcpResult.stderr}`);
  }
  log('crontick-mcp started without error (stopped after timeout)');

  cleanup();
  console.log('\n[verify-package-install] OK: tarball installs cleanly, exports resolve, and all three bins run.');
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
