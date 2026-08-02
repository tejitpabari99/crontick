// run-harness.mjs — integration harness entry point + orchestrator
// Usage: node tests/integration/run-harness.mjs [options]

import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { setup } from './setup.mjs';
import { assertSafeHome, rmWithRetry, runWithTimeout } from './utils.mjs';
import { killDaemonProcess, teardownGlobal } from './teardown.mjs';
import { runCli } from './drivers/cli-driver.mjs';
import { runApi } from './drivers/api-driver.mjs';
import { runMcp } from './drivers/mcp-driver.mjs';
import { pollUntilTerminal } from './poll.mjs';
import { KNOWN_CHECK_TYPES, runCheck } from './check-engine.mjs';
import { createReporter } from './reporter.mjs';

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

/** Filter and sort tests by options. */
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

/**
 * Expand ${VAR} tokens in a string using the vars map.
 * @param {string} str
 * @param {Record<string, string>} vars
 * @returns {string}
 */
function expandStr(str, vars) {
  return str.replace(/\$\{([^}]+)\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    return match;
  });
}

/**
 * Recursively expand ${VAR} tokens in any string values within a value tree.
 * @param {unknown} val
 * @param {Record<string, string>} vars
 * @returns {unknown}
 */
function expandInValue(val, vars) {
  if (typeof val === 'string') return expandStr(val, vars);
  if (Array.isArray(val)) return val.map((v) => expandInValue(v, vars));
  if (val !== null && typeof val === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(val)) result[k] = expandInValue(v, vars);
    return result;
  }
  return val;
}

/**
 * Execute a single invocation step (setup step, invocation, or cleanup step).
 * Returns the result object or throws on unrecoverable error.
 *
 * @param {object} step
 * @param {{ bins: object; scratchDir: string; testHome: string }} driverCtx
 * @param {Record<string, string>} vars - context vars for expansion
 * @param {boolean} bestEffort - if true, errors are caught and logged (for cleanup steps)
 * @returns {Promise<object|null>}
 */
async function runStep(step, driverCtx, vars, bestEffort = false) {
  try {
    const expanded = /** @type {object} */ (expandInValue(step, vars));
    const { surface } = expanded;

    if (surface === 'cli') {
      const result = await runCli(expanded.command ?? [], driverCtx);
      return result;
    }
    if (surface === 'api') {
      const result = await runApi(expanded.script ?? '', driverCtx);
      return result;
    }
    if (surface === 'mcp') {
      const result = await runMcp(expanded.tool ?? '', expanded.args ?? {}, driverCtx);
      return result;
    }
    if (surface === 'raw') {
      assertSafeHome(driverCtx.testHome, driverCtx.scratchDir);
      const isWindows = process.platform === 'win32';
      const rawCmd = isWindows && expanded.command === 'npm' ? 'npm.cmd' : expanded.command;
      const result = await runWithTimeout(
        rawCmd,
        expanded.args ?? [],
        {
          cwd: expanded.cwd ?? driverCtx.scratchDir,
          env: { ...process.env, CRONTICK_HOME: driverCtx.testHome },
          shell: isWindows && rawCmd.endsWith('.cmd'),
        },
        30_000,
      );
      return result;
    }
    throw new Error(`Unknown step surface: "${expanded.surface}"`);
  } catch (err) {
    if (bestEffort) {
      console.error(`  [cleanup warn] ${err.message}`);
      return null;
    }
    throw err;
  }
}

const REQUIRED_FIELDS = ['id', 'seq', 'title', 'area', 'surface', 'priority', 'tier', 'slow', 'invocations', 'checks'];

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

  // Validate: required fields
  for (const t of allTests) {
    for (const f of REQUIRED_FIELDS) {
      if (!(f in t)) {
        console.error(`Error: test "${t.id ?? '(no id)'}" is missing required field "${f}"`);
        process.exit(1);
      }
    }
  }

  // Validate: unique seq
  const seqMap = new Map();
  for (const t of allTests) {
    if (seqMap.has(t.seq)) {
      console.error(`Error: duplicate seq ${t.seq} used by both "${seqMap.get(t.seq)}" and "${t.id}"`);
      process.exit(1);
    }
    seqMap.set(t.seq, t.id);
  }

  // Validate: all check types are known
  for (const t of allTests) {
    for (const c of t.checks ?? []) {
      if (!KNOWN_CHECK_TYPES.has(c.type)) {
        console.error(`Error: test "${t.id}" uses unknown check type "${c.type}"`);
        process.exit(1);
      }
    }
  }

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

  // Run global setup
  let ctx;
  try {
    ctx = await setup({ build: opts.build });
  } catch (err) {
    console.error(`Global setup failed: ${err.message}`);
    process.exit(1);
  }

  const { scratchDir, homeRoot, bins, packageVersion, mockEnginePath, repoRoot } = ctx;
  const logDir = join(scratchDir, 'logs');
  mkdirSync(logDir, { recursive: true });

  const reporter = createReporter({ logDir, packageVersion, jsonToStdout: opts.json });

  let anyFailOrUnexpected = false;
  let aborted = false;

  for (const test of filtered) {
    if (aborted) break;

    const testId = test.id;
    const testHome = join(homeRoot, testId.toLowerCase());
    const testWork = join(testHome, 'work');

    // Platform skip check
    if (test.skipOn?.includes(process.platform)) {
      reporter.record({
        seq: test.seq,
        id: testId,
        title: test.title,
        area: test.area,
        surface: test.surface,
        tier: test.tier,
        status: 'skipped',
        durationMs: 0,
        checks: [],
        knownDefect: test.knownDefect ?? null,
        errorMessage: null,
        invocationLogs: null,
      });
      continue;
    }

    const startTime = Date.now();
    /** @type {Map<string, object>} */
    const invocationResults = new Map();
    /** @type {Record<string, {stdout:string; stderr:string}>} */
    const invocationLogs = {};
    /** @type {{ type: string; status: 'pass'|'fail'; message?: string }[]} */
    const checkResults = [];
    let testErrorMessage = null;

    try {
      // Create per-test dirs
      mkdirSync(testHome, { recursive: true });
      mkdirSync(testWork, { recursive: true });

      // HARD GUARD: assert testHome is under scratchDir
      assertSafeHome(testHome, scratchDir);

      // Build context variable map
      const vars = {
        SCRATCH_HOME: testHome,
        SCRATCH_WORK: testWork,
        SCRATCH_ROOT: scratchDir,
        PACKAGE_VERSION: packageVersion,
        MOCK_ENGINE_PATH: mockEnginePath,
        REPO_ROOT: repoRoot,
      };

      const driverCtx = { bins, scratchDir, testHome };

      // Run setup steps
      for (const step of test.setup ?? []) {
        await runStep(step, driverCtx, vars, false);
      }

      // Run invocations
      for (const inv of test.invocations ?? []) {
        const expandedInv = /** @type {object} */ (expandInValue(inv, vars));
        const { surface, ref } = expandedInv;
        let result;

        if (surface === 'cli') {
          result = await runCli(expandedInv.command ?? [], driverCtx);
          invocationLogs[ref] = { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
          invocationResults.set(ref, result);
        } else if (surface === 'api') {
          result = await runApi(expandedInv.script ?? '', driverCtx);
          invocationLogs[ref] = { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
          invocationResults.set(ref, result);
        } else if (surface === 'mcp') {
          result = await runMcp(expandedInv.tool ?? '', expandedInv.args ?? {}, driverCtx);
          invocationLogs[ref] = {
            stdout: JSON.stringify(result.mcpResponse),
            stderr: '',
          };
          invocationResults.set(ref, result);
        } else if (surface === 'raw') {
          assertSafeHome(testHome, scratchDir);
          const isWindows = process.platform === 'win32';
          const rawCmd = isWindows && expandedInv.command === 'npm' ? 'npm.cmd' : expandedInv.command;
          result = await runWithTimeout(
            rawCmd,
            expandedInv.args ?? [],
            {
              cwd: expandedInv.cwd ?? scratchDir,
              env: { ...process.env, CRONTICK_HOME: testHome },
              shell: isWindows && rawCmd.endsWith('.cmd'),
            },
            30_000,
          );
          invocationLogs[ref] = { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
          invocationResults.set(ref, result);
        } else {
          throw new Error(`Unknown invocation surface: "${surface}"`);
        }
      }

      // Optional polling
      if (test.pollJobUntilTerminal) {
        const { jobId, timeoutSec } = test.pollJobUntilTerminal;
        const expandedJobId = expandStr(jobId, vars);
        const cliRunner = (args) => runCli(args, driverCtx);
        await pollUntilTerminal(cliRunner, expandedJobId, { timeoutSec });
      }

      // Build check context
      const checkCtx = {
        testHome,
        scratchDir,
        cliRunner: (args) => runCli(args, driverCtx),
        expandVars: (str) => expandStr(str, vars),
      };

      // Run checks (expand context vars in params before evaluating)
      for (const check of test.checks ?? []) {
        const expandedCheck = /** @type {object} */ (expandInValue(check, vars));
        try {
          await runCheck(expandedCheck, invocationResults, checkCtx);
          checkResults.push({ type: expandedCheck.type, status: 'pass' });
        } catch (checkErr) {
          checkResults.push({ type: expandedCheck.type, status: 'fail', message: checkErr.message });
          if (testErrorMessage === null) testErrorMessage = `check[${checkResults.length - 1}] ${expandedCheck.type}: ${checkErr.message}`;
        }
      }
    } catch (err) {
      if (testErrorMessage === null) testErrorMessage = err.message;
    } finally {
      // Best-effort cleanup steps
      const driverCtxForCleanup = { bins, scratchDir, testHome };
      const vars = {
        SCRATCH_HOME: testHome,
        SCRATCH_WORK: testWork,
        SCRATCH_ROOT: scratchDir,
        PACKAGE_VERSION: packageVersion,
        MOCK_ENGINE_PATH: mockEnginePath,
        REPO_ROOT: repoRoot,
      };
      for (const step of test.cleanup ?? []) {
        await runStep(step, driverCtxForCleanup, vars, true);
      }

      // Kill daemon (reads daemon.pid)
      try { killDaemonProcess(testHome); } catch { /* best-effort */ }

      // Remove testHome unless --keep-home
      if (!opts.keepHome) {
        try { rmWithRetry(testHome); } catch { /* best-effort */ }
      }
    }

    // Classify result
    const anyCheckFailed = checkResults.some((c) => c.status === 'fail');
    const hasKnownDefect = Boolean(test.knownDefect);
    let testStatus;
    if (!anyCheckFailed && testErrorMessage === null) {
      testStatus = hasKnownDefect ? 'unexpected-pass' : 'pass';
    } else {
      testStatus = hasKnownDefect ? 'known-fail' : 'fail';
    }

    if (testStatus === 'fail' || testStatus === 'unexpected-pass') anyFailOrUnexpected = true;

    const durationMs = Date.now() - startTime;
    reporter.record({
      seq: test.seq,
      id: testId,
      title: test.title,
      area: test.area,
      surface: test.surface,
      tier: test.tier,
      status: testStatus,
      durationMs,
      checks: checkResults,
      knownDefect: test.knownDefect ?? null,
      errorMessage: testErrorMessage,
      invocationLogs,
    });

    if (opts.failFast && (testStatus === 'fail' || testStatus === 'unexpected-pass')) {
      console.error('--fail-fast: stopping after first failure');
      aborted = true;
    }
  }

  await reporter.flush();

  // Global teardown
  if (!opts.noCleanup) {
    try { teardownGlobal(ctx, { keepHome: opts.keepHome }); } catch { /* best-effort */ }
  }

  process.exit(anyFailOrUnexpected ? 1 : 0);
}

main();
