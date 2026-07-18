#!/usr/bin/env node
/**
 * After npm pack, verify the tarball contains expected files and structure.
 * Run: npm pack --dry-run  (or npm pack to create actual tarball)
 * Then: node scripts/verify-tarball.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const output = execSync('npm pack --dry-run --json', { encoding: 'utf-8' });
let packInfo;
try {
  packInfo = JSON.parse(output);
} catch {
  const lines = execSync('npm pack --dry-run 2>&1', { encoding: 'utf-8' }).split('\n');
  packInfo = null;
  console.log('Pack output:', lines.join('\n'));
}

if (packInfo) {
  const files = packInfo[0]?.files?.map((file) => file.path) ?? [];
  console.log(`\nPacked ${files.length} files:`);

  const checks = [
    { name: 'dist/cli/index.js', required: true },
    { name: 'dist/mcp/index.js', required: true },
    { name: 'dist/daemon/index.js', required: true },
    { name: 'dist/index.js', required: true },
    { name: 'dist/index.cjs', required: true },
    { name: 'dist/index.d.ts', required: true },
    { name: 'dist/index.d.cts', required: true },
    { name: 'src/skill/SKILL.md', required: true },
    { name: 'plugin/install.mjs', required: true },
    { name: 'README.md', required: true },
    { name: 'LICENSE', required: true },
  ];

  let allOk = true;
  for (const check of checks) {
    const found = files.some((file) => file === check.name || file.endsWith('/' + check.name));
    const status = found ? '✓' : check.required ? '✗ MISSING' : '- optional';
    console.log(`  ${status}: ${check.name}`);
    if (!found && check.required) allOk = false;
  }

  const testFiles = files.filter(
    (file) =>
      file.includes('/tests/')
      || file.includes('\\tests\\')
      || file.includes('/docs/plan/')
      || file.endsWith('.test.js')
      || file.endsWith('.test.ts'),
  );
  if (testFiles.length > 0) {
    console.error('\n✗ Test/plan files should not be in the package:');
    for (const file of testFiles) console.error(`  - ${file}`);
    allOk = false;
  } else {
    console.log('  ✓ No test files shipped');
  }

  if (!allOk) {
    console.error('\nTarball verification FAILED');
    process.exit(1);
  }
  console.log('\nTarball verification OK');
} else {
  const distChecks = [
    'dist/cli/index.js',
    'dist/mcp/index.js',
    'dist/daemon/index.js',
    'src/skill/SKILL.md',
    'plugin/install.mjs',
  ];
  let allOk = true;
  for (const file of distChecks) {
    if (existsSync(file)) {
      console.log(`  ✓ ${file}`);
    } else {
      console.error(`  ✗ MISSING: ${file}`);
      allOk = false;
    }
  }
  for (const file of ['dist/cli/index.js', 'dist/mcp/index.js', 'dist/daemon/index.js']) {
    if (existsSync(file)) {
      const firstLine = readFileSync(file, 'utf-8').split('\n')[0];
      if (firstLine.startsWith('#!/usr/bin/env node')) {
        console.log(`  ✓ shebang: ${file}`);
      } else {
        console.error(`  ✗ Missing shebang in ${file}: ${firstLine}`);
        allOk = false;
      }
    }
  }
  if (!allOk) process.exit(1);
  console.log('\nVerification OK');
}
