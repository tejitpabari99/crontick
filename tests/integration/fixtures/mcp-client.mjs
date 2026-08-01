// fixtures/mcp-client.mjs — thin stdio MCP client (no external deps)

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
 * @param {Function} runWithTimeout
 * @param {number} mcpTimeoutMs
 * @returns {Promise<object>} Parsed JSON-RPC response
 */
export async function mcpCall(
  bins,
  testHome,
  scratchDir,
  toolName,
  toolArgs,
  runWithTimeout,
  mcpTimeoutMs,
) {
  // TODO(A3): implement
  void bins;
  void testHome;
  void scratchDir;
  void toolName;
  void toolArgs;
  void runWithTimeout;
  void mcpTimeoutMs;
  throw new Error('mcpCall: not implemented');
}
