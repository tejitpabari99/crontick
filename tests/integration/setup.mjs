// setup.mjs — build+pack+install orchestrator

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmWithRetry, resolveInstalledBin, runWithTimeout } from './utils.mjs';

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

/**
 * @typedef {object} SetupContext
 * @property {string} repoRoot
 * @property {string} scratchDir
 * @property {string} homeRoot
 * @property {{ crontick: string; daemon: string; mcp: string }} bins
 * @property {string} packageVersion
 * @property {string} mockEnginePath
 */

/**
 * Runs global setup: optionally builds, packs, and installs crontick into
 * .e2e-scratch/, then resolves bin paths and verifies the installed version.
 *
 * @param {{ build?: boolean; clean?: boolean }} [opts]
 * @returns {Promise<SetupContext>}
 */
export async function setup({ build = false, clean = false } = {}) {
  const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const scratchDir = join(repoRoot, '.e2e-scratch');
  const homeRoot = join(scratchDir, 'crontick-home');

  // Safety: scratchDir must be inside repoRoot
  if (!resolve(scratchDir).startsWith(resolve(repoRoot) + sep)) {
    throw new Error(`SAFETY: scratchDir is not under repoRoot (${repoRoot})`);
  }

  const repoPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
  const packageVersion = repoPkg.version;

  // Optionally build
  if (build) {
    execFileSync(npmCmd, ['run', 'build'], { cwd: repoRoot, stdio: 'inherit', shell: isWindows });
  }

  // Install-reuse fast path
  const installedPkgPath = join(scratchDir, 'node_modules', 'crontick', 'package.json');
  let needsInstall = true;
  if (!clean && existsSync(installedPkgPath)) {
    try {
      const installedPkg = JSON.parse(readFileSync(installedPkgPath, 'utf-8'));
      if (installedPkg.version === packageVersion) {
        needsInstall = false;
      }
    } catch {
      // fall through to reinstall
    }
  }

  if (needsInstall) {
    // Pack tarball
    const packOutput = execFileSync(npmCmd, ['pack', '--json'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      shell: isWindows,
    });
    const [packInfo] = JSON.parse(packOutput);
    const tarballPath = join(repoRoot, packInfo.filename);

    // Create scratch dir with minimal package.json
    mkdirSync(scratchDir, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });
    writeFileSync(
      join(scratchDir, 'package.json'),
      JSON.stringify({ name: 'crontick-e2e-scratch', version: '0.0.0', private: true }, null, 2),
    );

    // Install tarball
    execFileSync(npmCmd, ['install', tarballPath, '--no-audit', '--no-fund', '--no-save'], {
      cwd: scratchDir,
      stdio: 'inherit',
      shell: isWindows,
    });

    // Delete tarball
    rmWithRetry(tarballPath);
  }

  // Resolve bins
  const bins = {
    crontick: resolveInstalledBin(scratchDir, 'crontick'),
    daemon: resolveInstalledBin(scratchDir, 'crontick-daemon'),
    mcp: resolveInstalledBin(scratchDir, 'crontick-mcp'),
  };

  // Version sanity check
  const versionResult = await runWithTimeout(
    process.execPath,
    [bins.crontick, '--version'],
    { cwd: scratchDir },
    15000,
  );
  const reportedVersion = versionResult.stdout.trim();
  if (reportedVersion !== packageVersion) {
    throw new Error(
      `Version mismatch: installed bin reports "${reportedVersion}" but package.json says "${packageVersion}"`,
    );
  }

  const mockEnginePath = resolve(fileURLToPath(new URL('fixtures/mock-engine.cjs', import.meta.url)));

  return { repoRoot, scratchDir, homeRoot, bins, packageVersion, mockEnginePath };
}
