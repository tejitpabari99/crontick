// check-engine.mjs — check-type registry + assertion dispatcher

import { existsSync, readFileSync } from 'node:fs';

/** Canonical set of all known check type names. */
export const KNOWN_CHECK_TYPES = new Set([
  'exitCodeEquals',
  'stdoutContains',
  'stdoutNotContains',
  'stderrContains',
  'stdoutJsonPathEquals',
  'stdoutJsonArrayLength',
  'apiResultJsonPathEquals',
  'mcpToolResultJsonPath',
  'fileExists',
  'fileNotExists',
  'fileContentEquals',
  'fileContentContains',
  'runStatusEquals',
  'runExitCodeEquals',
  'runErrorMatches',
  'runLogContains',
  'crossSurfaceFieldEquals',
  'stdoutJsonArrayContains',
  'stdoutJsonArrayNotContains',
  'daemonHealthOk',
]);

/**
 * Navigate a dot-notation JSON path with optional [N] array indices.
 * e.g. "action.args[0]" → obj.action.args[0]
 * @param {unknown} obj
 * @param {string} path
 * @returns {unknown}
 */
function jsonPathGet(obj, path) {
  const parts = [];
  for (const segment of path.split('.')) {
    const matches = segment.split(/(\[\d+\])/);
    for (const m of matches) {
      if (!m) continue;
      const arrIdx = /^\[(\d+)\]$/.exec(m);
      if (arrIdx) {
        parts.push(Number(arrIdx[1]));
      } else {
        parts.push(m);
      }
    }
  }
  let cur = obj;
  for (const key of parts) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Deep equality check.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual(a[k], b[k]));
}

/**
 * Runs a single check against the results map.
 *
 * @param {object} check - The check entry from tests.json
 * @param {Map<string, object>} invocationResults - Map from invocationRef → result
 * @param {object} ctx - Run context ({ testHome, scratchDir, cliRunner, expandVars })
 * @returns {Promise<void>} Resolves on pass; throws with a descriptive message on failure.
 */
export async function runCheck(check, invocationResults, ctx) {
  const { type, invocationRef, params } = check;

  // Resolve the invocation result (null for surface-independent checks)
  const lastRef = invocationResults.size > 0 ? [...invocationResults.keys()].at(-1) : null;
  const ref = invocationRef ?? lastRef;
  const result = invocationResults.get(ref);

  switch (type) {
    case 'exitCodeEquals': {
      const { expectedCode } = params;
      if (result?.exitCode !== expectedCode) {
        throw new Error(
          `exitCodeEquals: expected exit code ${expectedCode} but got ${result?.exitCode ?? 'null'}\nstderr: ${result?.stderr?.slice(0, 300) ?? ''}`,
        );
      }
      break;
    }

    case 'stdoutContains': {
      const { substring, caseSensitive = true } = params;
      const stdout = result?.stdout ?? '';
      const pass = caseSensitive
        ? stdout.includes(substring)
        : stdout.toLowerCase().includes(substring.toLowerCase());
      if (!pass) {
        throw new Error(
          `stdoutContains: expected stdout to contain "${substring}" but got:\n${stdout.slice(0, 500)}`,
        );
      }
      break;
    }

    case 'stdoutNotContains': {
      const { forbidden } = params;
      const stdout = result?.stdout ?? '';
      if (stdout.includes(forbidden)) {
        throw new Error(`stdoutNotContains: expected stdout NOT to contain "${forbidden}"`);
      }
      break;
    }

    case 'stderrContains': {
      const { substring } = params;
      const stderr = result?.stderr ?? '';
      if (!stderr.includes(substring)) {
        throw new Error(
          `stderrContains: expected stderr to contain "${substring}" but got:\n${stderr.slice(0, 500)}`,
        );
      }
      break;
    }

    case 'stdoutJsonPathEquals': {
      const { jsonPath, expectedValue } = params;
      let parsed;
      try {
        parsed = JSON.parse(result?.stdout ?? '');
      } catch {
        throw new Error(
          `stdoutJsonPathEquals: stdout is not valid JSON: ${(result?.stdout ?? '').slice(0, 200)}`,
        );
      }
      const actual = jsonPathGet(parsed, jsonPath);
      if (!deepEqual(actual, expectedValue)) {
        throw new Error(
          `stdoutJsonPathEquals: at "${jsonPath}" expected ${JSON.stringify(expectedValue)} but got ${JSON.stringify(actual)}`,
        );
      }
      break;
    }

    case 'stdoutJsonArrayLength': {
      const { expectedLength } = params;
      let arr;
      try {
        arr = JSON.parse(result?.stdout ?? '');
      } catch {
        throw new Error('stdoutJsonArrayLength: stdout is not valid JSON');
      }
      if (!Array.isArray(arr)) throw new Error('stdoutJsonArrayLength: stdout is not a JSON array');
      if (arr.length !== expectedLength) {
        throw new Error(`stdoutJsonArrayLength: expected length ${expectedLength} but got ${arr.length}`);
      }
      break;
    }

    case 'apiResultJsonPathEquals': {
      const { jsonPath, expectedValue } = params;
      const parsed = result?.parsed;
      const actual = jsonPathGet(parsed, jsonPath);
      if (!deepEqual(actual, expectedValue)) {
        throw new Error(
          `apiResultJsonPathEquals: at "${jsonPath}" expected ${JSON.stringify(expectedValue)} but got ${JSON.stringify(actual)}`,
        );
      }
      break;
    }

    case 'mcpToolResultJsonPath': {
      const { jsonPath, expectedValue } = params;
      const mcpResult = result?.mcpResponse?.result;
      if (!mcpResult) throw new Error('mcpToolResultJsonPath: no MCP result available');
      let parsed;
      const textContent = mcpResult.content?.[0]?.text ?? '';
      try {
        parsed = JSON.parse(textContent);
      } catch {
        // text is not JSON (e.g. plain error message) — use empty object
        parsed = {};
      }
      // Merge top-level MCP result fields (e.g. isError) into parsed for navigation
      if (mcpResult.isError !== undefined) parsed = { ...parsed, isError: mcpResult.isError };
      const actual = jsonPathGet(parsed, jsonPath);
      if (!deepEqual(actual, expectedValue)) {
        throw new Error(
          `mcpToolResultJsonPath: at "${jsonPath}" expected ${JSON.stringify(expectedValue)} but got ${JSON.stringify(actual)}\ntext: ${textContent.slice(0, 200)}`,
        );
      }
      break;
    }

    case 'fileExists': {
      const { pathTemplate } = params;
      const resolvedPath = ctx.expandVars(pathTemplate);
      if (!existsSync(resolvedPath)) {
        throw new Error(`fileExists: path does not exist: ${resolvedPath}`);
      }
      break;
    }

    case 'fileNotExists': {
      const { pathTemplate } = params;
      const resolvedPath = ctx.expandVars(pathTemplate);
      if (existsSync(resolvedPath)) {
        throw new Error(`fileNotExists: path should not exist but does: ${resolvedPath}`);
      }
      break;
    }

    case 'fileContentEquals': {
      const { pathTemplate, expected, trim = true } = params;
      const resolvedPath = ctx.expandVars(pathTemplate);
      let content;
      try {
        content = readFileSync(resolvedPath, 'utf-8');
      } catch {
        throw new Error(`fileContentEquals: could not read file: ${resolvedPath}`);
      }
      const actual = trim ? content.trim() : content;
      const exp = trim ? String(expected).trim() : String(expected);
      if (actual !== exp) {
        throw new Error(`fileContentEquals: file "${resolvedPath}" expected "${exp}" but got "${actual}"`);
      }
      break;
    }

    case 'fileContentContains': {
      const { pathTemplate, substring } = params;
      const resolvedPath = ctx.expandVars(pathTemplate);
      let content;
      try {
        content = readFileSync(resolvedPath, 'utf-8');
      } catch {
        throw new Error(`fileContentContains: could not read file: ${resolvedPath}`);
      }
      if (!content.includes(substring)) {
        throw new Error(`fileContentContains: file "${resolvedPath}" does not contain "${substring}"`);
      }
      break;
    }

    case 'runStatusEquals': {
      const { jobId, runIndex, expectedStatus } = params;
      const r = await ctx.cliRunner(['runs', 'list', '--job', jobId, '--json']);
      let runs;
      try {
        runs = JSON.parse(r.stdout || '[]');
      } catch {
        throw new Error(`runStatusEquals: could not parse runs list JSON: ${r.stdout?.slice(0, 200)}`);
      }
      if (!Array.isArray(runs) || runs.length <= runIndex) {
        throw new Error(`runStatusEquals: run index ${runIndex} not found (got ${runs.length} runs)`);
      }
      const actual = runs[runIndex].status;
      if (actual !== expectedStatus) {
        throw new Error(`runStatusEquals: expected status "${expectedStatus}" but got "${actual}"`);
      }
      break;
    }

    case 'runExitCodeEquals': {
      const { jobId, runIndex, expectedExitCode } = params;
      const r = await ctx.cliRunner(['runs', 'list', '--job', jobId, '--json']);
      let runs;
      try {
        runs = JSON.parse(r.stdout || '[]');
      } catch {
        throw new Error(`runExitCodeEquals: could not parse runs list JSON`);
      }
      if (!Array.isArray(runs) || runs.length <= runIndex) {
        throw new Error(`runExitCodeEquals: run index ${runIndex} not found (got ${runs.length} runs)`);
      }
      const actual = runs[runIndex].exitCode;
      if (actual !== expectedExitCode) {
        throw new Error(`runExitCodeEquals: expected exitCode ${expectedExitCode} but got ${actual}`);
      }
      break;
    }

    case 'runErrorMatches': {
      const { jobId, runIndex, pattern } = params;
      const r = await ctx.cliRunner(['runs', 'list', '--job', jobId, '--json']);
      let runs;
      try {
        runs = JSON.parse(r.stdout || '[]');
      } catch {
        throw new Error('runErrorMatches: could not parse runs list JSON');
      }
      if (!Array.isArray(runs) || runs.length <= runIndex) {
        throw new Error(`runErrorMatches: run index ${runIndex} not found`);
      }
      const errorStr = runs[runIndex].error ?? '';
      if (!new RegExp(pattern).test(errorStr)) {
        throw new Error(`runErrorMatches: error "${errorStr}" does not match /${pattern}/`);
      }
      break;
    }

    case 'runLogContains': {
      const { runId, jobId, substring } = params;
      let resolvedRunId = runId;
      if (!resolvedRunId && jobId) {
        const r = await ctx.cliRunner(['runs', 'list', '--job', jobId, '--json']);
        let runs;
        try {
          runs = JSON.parse(r.stdout || '[]');
        } catch {
          throw new Error('runLogContains: could not parse runs list JSON');
        }
        if (!Array.isArray(runs) || runs.length === 0) {
          throw new Error(`runLogContains: no runs found for job ${jobId}`);
        }
        resolvedRunId = runs[0].id;
      }
      if (!resolvedRunId) throw new Error('runLogContains: no runId and no jobId provided');
      const logResult = await ctx.cliRunner(['logs', resolvedRunId]);
      const combined = logResult.stdout + logResult.stderr;
      if (!combined.includes(substring)) {
        throw new Error(`runLogContains: logs for run ${resolvedRunId} do not contain "${substring}"`);
      }
      break;
    }

    case 'crossSurfaceFieldEquals': {
      const { refs, jsonPath } = params;
      const values = refs.map((r) => {
        const res = invocationResults.get(r);
        if (!res) throw new Error(`crossSurfaceFieldEquals: invocation ref "${r}" not found`);
        if (res.mcpResponse !== undefined) {
          const mcpRes = res.mcpResponse.result;
          if (!mcpRes) throw new Error(`crossSurfaceFieldEquals: ref "${r}" has no MCP result`);
          const textContent = mcpRes.content?.[0]?.text ?? '';
          let mcpParsed;
          try {
            mcpParsed = JSON.parse(textContent);
          } catch {
            mcpParsed = {};
          }
          if (mcpRes.isError !== undefined) mcpParsed = { ...mcpParsed, isError: mcpRes.isError };
          return jsonPathGet(mcpParsed, jsonPath);
        }
        if (res.parsed !== undefined) {
          return jsonPathGet(res.parsed, jsonPath);
        }
        if (res.stdout !== undefined) {
          try {
            return jsonPathGet(JSON.parse(res.stdout), jsonPath);
          } catch {
            throw new Error(`crossSurfaceFieldEquals: ref "${r}" stdout is not valid JSON`);
          }
        }
        return undefined;
      });
      const first = values[0];
      for (let i = 1; i < values.length; i++) {
        if (!deepEqual(first, values[i])) {
          throw new Error(
            `crossSurfaceFieldEquals: refs[0] value ${JSON.stringify(first)} != refs[${i}] value ${JSON.stringify(values[i])} at path "${jsonPath}"`,
          );
        }
      }
      break;
    }

    case 'stdoutJsonArrayContains': {
      const { expectedItems } = params;
      let arr;
      try {
        arr = JSON.parse(result?.stdout ?? '');
      } catch {
        throw new Error('stdoutJsonArrayContains: stdout is not valid JSON');
      }
      if (!Array.isArray(arr)) throw new Error('stdoutJsonArrayContains: stdout is not a JSON array');
      for (const item of expectedItems) {
        if (!arr.includes(item)) {
          throw new Error(`stdoutJsonArrayContains: array does not contain "${item}"`);
        }
      }
      break;
    }

    case 'stdoutJsonArrayNotContains': {
      const { forbiddenItems } = params;
      let arr;
      try {
        arr = JSON.parse(result?.stdout ?? '');
      } catch {
        throw new Error('stdoutJsonArrayNotContains: stdout is not valid JSON');
      }
      if (!Array.isArray(arr)) throw new Error('stdoutJsonArrayNotContains: stdout is not a JSON array');
      for (const item of forbiddenItems) {
        if (arr.includes(item)) {
          throw new Error(`stdoutJsonArrayNotContains: array must not contain "${item}"`);
        }
      }
      break;
    }

    case 'daemonHealthOk': {
      const portFile = `${ctx.testHome}/daemon.port`;
      let port;
      try {
        port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
      } catch {
        throw new Error(`daemonHealthOk: could not read port from ${portFile}`);
      }
      if (!Number.isFinite(port) || port <= 0) {
        throw new Error(`daemonHealthOk: invalid port value in ${portFile}`);
      }
      const url = `http://127.0.0.1:${port}/health`;
      let resp;
      try {
        resp = await fetch(url);
      } catch (e) {
        throw new Error(`daemonHealthOk: GET ${url} failed: ${e.message}`);
      }
      let body;
      try {
        body = await resp.json();
      } catch {
        throw new Error('daemonHealthOk: response body is not valid JSON');
      }
      if (!body.ok) {
        throw new Error(`daemonHealthOk: expected { ok: true } but got ${JSON.stringify(body)}`);
      }
      break;
    }

    default:
      throw new Error(`runCheck: unknown check type "${type}"`);
  }
}
