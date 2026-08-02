// mcp-driver.mjs — drives MCP server via stdio JSON-RPC

import { mcpCall } from '../fixtures/mcp-client.mjs';

/** Default MCP timeout in milliseconds. */
const MCP_TIMEOUT_MS = 30_000;

/**
 * Calls a crontick MCP tool and returns the parsed response.
 *
 * @param {string} toolName - MCP tool name (e.g. 'crontick_daemon_status')
 * @param {object} toolArgs - Tool arguments object
 * @param {{ bins: { mcp: string }; scratchDir: string; testHome: string; env?: Record<string, string> }} ctx
 * @returns {Promise<{ mcpResponse: object }>} Object with mcpResponse (id:2 JSON-RPC response)
 */
export async function runMcp(toolName, toolArgs, ctx) {
  const { bins, scratchDir, testHome } = ctx;
  const mcpResponse = await mcpCall(bins, testHome, scratchDir, toolName, toolArgs, MCP_TIMEOUT_MS);
  return { mcpResponse };
}
