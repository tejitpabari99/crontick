// fixtures/mcp-client.mjs — thin stdio MCP client (no external deps)

import { assertSafeHome, runWithTimeout } from '../utils.mjs';

/**
 * Calls a single MCP tool via stdio JSON-RPC 2.0.
 * Spawns `crontick-mcp`, sends initialize + notifications/initialized + tools/call,
 * then correlates the response by id === 2.
 *
 * @param {{ mcp: string }} bins
 * @param {string} testHome
 * @param {string} scratchDir
 * @param {string} toolName
 * @param {object} toolArgs
 * @param {number} [mcpTimeoutMs]
 * @returns {Promise<object>} Parsed JSON-RPC response (id:2)
 */
export async function mcpCall(
  bins,
  testHome,
  scratchDir,
  toolName,
  toolArgs,
  mcpTimeoutMs = 30_000,
) {
  assertSafeHome(testHome, scratchDir);

  const msgs = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'harness', version: '0.0.0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: toolArgs },
    },
  ];

  const inputData = msgs.map((m) => JSON.stringify(m)).join('\n') + '\n';

  const result = await runWithTimeout(
    process.execPath,
    [bins.mcp],
    {
      cwd: scratchDir,
      env: { ...process.env, CRONTICK_HOME: testHome },
      inputData,
    },
    mcpTimeoutMs,
  );

  const lines = result.stdout.split('\n');
  const responseLine = lines.find((l) => {
    try {
      const p = JSON.parse(l);
      return p.id === 2;
    } catch {
      return false;
    }
  });

  if (!responseLine) {
    throw new Error(
      `MCP: no response with id:2 in stdout\nstdout: ${result.stdout.slice(0, 500)}\nstderr: ${result.stderr.slice(0, 300)}`,
    );
  }

  const parsed = JSON.parse(responseLine);
  if (parsed.error !== undefined) {
    throw new Error(
      `MCP tool "${toolName}" returned JSON-RPC error: code=${parsed.error.code}, message=${parsed.error.message}`,
    );
  }
  return parsed;
}
