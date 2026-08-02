// reporter.mjs — console output + JSON summary writer

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Creates a new reporter instance for a harness run.
 * @param {{ logDir: string; packageVersion: string; jsonToStdout: boolean }} opts
 * @returns {Reporter}
 */
export function createReporter(opts) {
  const { logDir, packageVersion, jsonToStdout } = opts;

  const runId = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, '');
  const thisLogDir = join(logDir, runId);
  mkdirSync(thisLogDir, { recursive: true });

  const startedAt = new Date().toISOString();
  /** @type {TestResult[]} */
  const results = [];

  /**
   * Record one test result and print its console line.
   * @param {TestResult} testResult
   */
  function record(testResult) {
    results.push(testResult);

    const { seq, id, title, status, durationMs, knownDefect, errorMessage } = testResult;
    const seqStr = String(seq).padStart(3, '0');

    let icon;
    let suffix = '';
    switch (status) {
      case 'pass':
        icon = '✓';
        break;
      case 'fail':
        icon = '✗';
        break;
      case 'known-fail':
        icon = '⚠';
        suffix = ` [KNOWN-DEFECT: ${knownDefect}]`;
        break;
      case 'unexpected-pass':
        icon = '⚡';
        suffix = ` [UNEXPECTED PASS: ${knownDefect} — verify defect is fixed and remove knownDefect tag]`;
        break;
      case 'skipped':
        icon = '-';
        suffix = ` [SKIPPED: ${process.platform}]`;
        break;
      default:
        icon = '?';
    }

    console.log(`${icon} [${seqStr}] ${id} — ${title}${suffix}  (${durationMs}ms)`);
    if (status === 'fail' && errorMessage) {
      // indent failure message for readability
      for (const line of errorMessage.split('\n').slice(0, 6)) {
        console.log(`    ${line}`);
      }
    }

    // Write per-test log file
    const logFile = join(thisLogDir, `${id.toLowerCase()}.log`);
    const lines = [`Test: ${id}`, `Status: ${status}`, `Duration: ${durationMs}ms`, ''];
    if (testResult.invocationLogs) {
      for (const [refName, inv] of Object.entries(testResult.invocationLogs)) {
        lines.push(`--- invocation: ${refName} ---`);
        lines.push(`STDOUT:\n${inv.stdout ?? ''}`);
        lines.push(`STDERR:\n${inv.stderr ?? ''}`);
        lines.push('');
      }
    }
    if (errorMessage) lines.push(`ERROR: ${errorMessage}`);
    try {
      writeFileSync(logFile, lines.join('\n'), 'utf-8');
    } catch {
      // best-effort
    }
  }

  /**
   * Flush: print summary, write run-summary.json, optionally write JSON to stdout.
   * @returns {Promise<void>}
   */
  async function flush() {
    const endedAt = new Date().toISOString();

    let passed = 0;
    let failed = 0;
    let knownFail = 0;
    let unexpectedPass = 0;
    let skipped = 0;
    for (const r of results) {
      if (r.status === 'pass') passed++;
      else if (r.status === 'fail') failed++;
      else if (r.status === 'known-fail') knownFail++;
      else if (r.status === 'unexpected-pass') unexpectedPass++;
      else if (r.status === 'skipped') skipped++;
    }

    console.log('');
    console.log(
      `Results: ${passed} passed, ${failed} failed, ${knownFail} known-fail, ${unexpectedPass} unexpected-pass, ${skipped} skipped`,
    );
    console.log(`Log dir: ${thisLogDir}`);

    const summary = {
      runId,
      startedAt,
      endedAt,
      packageVersion,
      totalTests: results.length,
      passed,
      failed,
      knownFail,
      unexpectedPass,
      skipped,
      results: results.map((r) => ({
        seq: r.seq,
        id: r.id,
        title: r.title,
        area: r.area,
        surface: r.surface,
        tier: r.tier,
        status: r.status,
        durationMs: r.durationMs,
        checks: r.checks,
      })),
    };

    const summaryPath = join(thisLogDir, 'run-summary.json');
    try {
      writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
    } catch {
      // best-effort
    }

    if (jsonToStdout) {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    }
  }

  return { record, flush };
}

/**
 * @typedef {object} Reporter
 * @property {(result: TestResult) => void} record
 * @property {() => Promise<void>} flush
 */

/**
 * @typedef {object} TestResult
 * @property {number} seq
 * @property {string} id
 * @property {string} title
 * @property {string} area
 * @property {string[]} surface
 * @property {string} tier
 * @property {'pass'|'fail'|'known-fail'|'unexpected-pass'|'skipped'} status
 * @property {number} durationMs
 * @property {{ type: string; status: 'pass'|'fail'; message?: string }[]} checks
 * @property {string|null} knownDefect
 * @property {string|null} errorMessage
 * @property {Record<string, {stdout: string; stderr: string}>|null} [invocationLogs]
 */
