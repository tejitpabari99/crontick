#!/usr/bin/env node
/**
 * Advisory: verify package.json deps are present in package-lock.json root dependencies.
 * Fails (exit 1) if any prod/dev dep declared in package.json is missing from the lock file root.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf-8'));

const declaredDeps = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);

const lockPackages = lock.packages ?? {};
const lockRootDeps = new Set(
  Object.keys(lockPackages)
    .filter((key) => /^node_modules\/(?:@[^/]+\/)?[^/]+$/.test(key))
    .map((key) => key.slice('node_modules/'.length)),
);

const missing = [...declaredDeps].filter((dep) => !lockRootDeps.has(dep));

if (missing.length > 0) {
  console.error('[verify-lockfile] FAIL: These deps are in package.json but not in package-lock.json root:');
  for (const dep of missing) console.error(`  - ${dep}`);
  process.exit(1);
}

console.log(`[verify-lockfile] OK: all ${declaredDeps.size} dependencies present in package-lock.json`);
