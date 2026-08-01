// run-harness.mjs — integration harness entry point + orchestrator
// Usage: node tests/integration/run-harness.mjs [options]

import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTS_JSON = join(__dirname, 'tests.json');

/** Parse argv into an options object. */
function parseArgs(argv) {
  const opts = {
    start: null,
    end: null,
    id: null,
    tier: null,
    area: null,
    surface: null,
    list: false,
    dryRun: false,
    keepHome: false,
    failFast: false,
    json: false,
    build: false,
    noCleanup: false,
    // Stubbed for later:
    priority: null,
    tag: null,
    filter: null,
    repeat: null,
    parallel: null,
    timeoutScale: null,
    reportDir: null,
  };

  const STUB_ARGS = new Set([
    '--priority', '--tag', '--filter', '--repeat',
    '--parallel', '--timeout-scale', '--report-dir',
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') { opts.list = true; }
    else if (arg === '--dry-run') { opts.dryRun = true; }
    else if (arg === '--keep-home') { opts.keepHome = true; }
    else if (arg === '--fail-fast') { opts.failFast = true; }
    else if (arg === '--json') { opts.json = true; }
    else if (arg === '--build') { opts.build = true; }
    else if (arg === '--no-cleanup') { opts.noCleanup = true; opts.keepHome = true; }
    else if (arg === '--start') { opts.start = Number(argv[++i]); }
    else if (arg === '--end') { opts.end = Number(argv[++i]); }
    else if (arg === '--id') { opts.id = argv[++i]; }
    else if (arg === '--tier') { opts.tier = argv[++i]; }
    else if (arg === '--area') { opts.area = argv[++i]; }
    else if (arg === '--surface') { opts.surface = argv[++i]; }
    else if (STUB_ARGS.has(arg)) {
      const val = argv[++i];
      console.error(`Warning: ${arg} ${val} is not yet implemented and will be ignored.`);
    } else {
      console.error(`Warning: unknown argument: ${arg}`);
    }
  }
  return opts;
}

const TIER_ORDER = ['smoke', 'tier1', 'tier2', 'tier3'];

/** Filter tests by options. */
function filterTests(tests, opts) {
  let filtered = tests.slice();

  if (opts.id) {
    filtered = filtered.filter((t) => t.id === opts.id);
  } else {
    if (opts.start !== null) filtered = filtered.filter((t) => t.seq >= opts.start);
    if (opts.end !== null) filtered = filtered.filter((t) => t.seq <= opts.end);
    if (opts.tier) {
      const maxIdx = TIER_ORDER.indexOf(opts.tier);
      if (maxIdx === -1) {
        console.error(`Error: unknown tier "${opts.tier}". Valid tiers: ${TIER_ORDER.join(', ')}`);
        process.exit(1);
      }
      filtered = filtered.filter((t) => TIER_ORDER.indexOf(t.tier) <= maxIdx);
    }
    if (opts.area) filtered = filtered.filter((t) => t.area === opts.area);
    if (opts.surface) filtered = filtered.filter((t) => Array.isArray(t.surface) && t.surface.includes(opts.surface));
  }

  return filtered.sort((a, b) => a.seq - b.seq);
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  let testsJson;
  try {
    const raw = await readFile(TESTS_JSON, 'utf-8');
    testsJson = JSON.parse(raw);
  } catch (err) {
    console.error(`Error reading tests.json: ${err.message}`);
    process.exit(1);
  }

  if (!testsJson.tests || !Array.isArray(testsJson.tests)) {
    console.error('Error: tests.json must have a "tests" array');
    process.exit(1);
  }

  const allTests = testsJson.tests;
  const filtered = filterTests(allTests, opts);

  if (opts.list) {
    if (filtered.length === 0) {
      console.log('no tests defined');
    } else {
      for (const t of filtered) {
        const skipNote = t.skipOn?.includes(process.platform) ? ` [SKIP on ${process.platform}]` : '';
        console.log(`[${String(t.seq).padStart(4, '0')}] ${t.id}  ${t.tier}  ${t.title}${skipNote}`);
      }
    }
    process.exit(0);
  }

  if (opts.dryRun) {
    if (filtered.length === 0) {
      console.log('no tests defined');
    } else {
      console.log(`Dry run — would execute ${filtered.length} test(s):`);
      for (const t of filtered) {
        const skipNote = t.skipOn?.includes(process.platform) ? ' [SKIP]' : '';
        console.log(`  [${String(t.seq).padStart(4, '0')}] ${t.id}  ${t.tier}  ${t.title}${skipNote}`);
      }
    }
    process.exit(0);
  }

  // TODO(A3): run setup.mjs, execute tests, run teardown
  // For now, print a placeholder so the entry point is exercisable.
  console.error('Harness execution not yet implemented (Task A3+). Use --list or --dry-run.');
  process.exit(1);
}

// Suppress unused import warning for createReadStream (used in later tasks).
void createReadStream;

main();
